//! Draws NV12 frames with wgpu (Metal on macOS): YUV → RGB in a shader,
//! letterboxed, plus the on-screen progress bar with the cached span.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use bytemuck::{Pod, Zeroable};
use winit::window::Window;

/// Width of the cache-coverage strip drawn behind the progress bar.
pub const COVERAGE_BUCKETS: usize = 512;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    /// Video rectangle in screen UV (x0, y0, x1, y1).
    rect: [f32; 4],
    /// OSD alpha, played fraction, 1.0 once a frame is up, 1.0 for BT.601.
    osd: [f32; 4],
    /// Screen width, height (pixels), scale factor, unused.
    screen: [f32; 4],
}

pub struct Osd {
    pub alpha: f32,
    pub played: f32,
}

pub struct Renderer {
    surface: wgpu::Surface<'static>,
    device: wgpu::Device,
    queue: wgpu::Queue,
    config: wgpu::SurfaceConfiguration,
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    uniforms: wgpu::Buffer,
    coverage: wgpu::Texture,
    planes: Option<(wgpu::Texture, wgpu::Texture, wgpu::BindGroup)>,
    video: (u32, u32),
    aspect: f64,
    bt601: bool,
    scale: f32,
    /// A frame was uploaded; until then the picture is black.
    has_frame: bool,
}

impl Renderer {
    pub fn new(window: Arc<Window>, video: (u32, u32), aspect: f64) -> Result<Self> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor::default());
        let size = window.inner_size();
        let scale = window.scale_factor() as f32;
        let surface = instance.create_surface(window)?;
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::LowPower,
            compatible_surface: Some(&surface),
            force_fallback_adapter: false,
        }))
        .ok_or_else(|| anyhow!("no GPU adapter"))?;
        let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor::default(), None))?;
        let caps = surface.get_capabilities(&adapter);
        // The decoded values are already gamma-encoded: an sRGB target
        // would encode them twice and wash the picture out.
        let format = caps.formats.iter().copied().find(|format| !format.is_srgb()).unwrap_or(caps.formats[0]);
        let config = wgpu::SurfaceConfiguration {
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
            format,
            width: size.width.max(1),
            height: size.height.max(1),
            present_mode: wgpu::PresentMode::Fifo,
            alpha_mode: caps.alpha_modes[0],
            view_formats: vec![],
            desired_maximum_frame_latency: 2,
        };
        surface.configure(&device, &config);

        let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("video"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });
        let texture_entry = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT,
            ty: wgpu::BindingType::Texture {
                sample_type: wgpu::TextureSampleType::Float { filterable: true },
                view_dimension: wgpu::TextureViewDimension::D2,
                multisampled: false,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("video"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
                texture_entry(1),
                texture_entry(2),
                texture_entry(3),
                wgpu::BindGroupLayoutEntry {
                    binding: 4,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("video"),
            bind_group_layouts: &[&layout],
            push_constant_ranges: &[],
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("video"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &shader,
                entry_point: Some("vs"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &shader,
                entry_point: Some("fs"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });
        let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("uniforms"),
            size: std::mem::size_of::<Uniforms>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let coverage = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("coverage"),
            size: wgpu::Extent3d { width: COVERAGE_BUCKETS as u32, height: 1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::R8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let mut renderer = Self {
            surface,
            device,
            queue,
            config,
            pipeline,
            layout,
            sampler,
            uniforms,
            coverage,
            planes: None,
            video,
            aspect,
            bt601: video.1 < 720,
            scale,
            has_frame: false,
        };
        renderer.create_planes();
        Ok(renderer)
    }

    fn create_planes(&mut self) {
        let (width, height) = self.video;
        let plane = |label, width, height, format| {
            self.device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            })
        };
        let luma = plane("luma", width, height, wgpu::TextureFormat::R8Unorm);
        let chroma = plane("chroma", width / 2, height / 2, wgpu::TextureFormat::Rg8Unorm);
        let view = |texture: &wgpu::Texture| texture.create_view(&Default::default());
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("video"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: self.uniforms.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&view(&luma)) },
                wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::TextureView(&view(&chroma)) },
                wgpu::BindGroupEntry {
                    binding: 3,
                    resource: wgpu::BindingResource::TextureView(&view(&self.coverage)),
                },
                wgpu::BindGroupEntry { binding: 4, resource: wgpu::BindingResource::Sampler(&self.sampler) },
            ],
        });
        self.planes = Some((luma, chroma, bind_group));
    }

    pub fn resize(&mut self, width: u32, height: u32, scale: f64) {
        self.config.width = width.max(1);
        self.config.height = height.max(1);
        self.scale = scale as f32;
        self.surface.configure(&self.device, &self.config);
    }

    /// Uploads one NV12 frame.
    pub fn upload(&mut self, nv12: &[u8]) {
        let (width, height) = self.video;
        let Some((luma, chroma, _)) = &self.planes else { return };
        let luma_bytes = (width * height) as usize;
        let write = |texture: &wgpu::Texture, data: &[u8], row: u32, width: u32, height: u32| {
            self.queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture,
                    mip_level: 0,
                    origin: wgpu::Origin3d::ZERO,
                    aspect: wgpu::TextureAspect::All,
                },
                data,
                wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(height) },
                wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            );
        };
        write(luma, &nv12[..luma_bytes], width, width, height);
        write(chroma, &nv12[luma_bytes..], width, width / 2, height / 2);
        self.has_frame = true;
    }

    pub fn set_coverage(&self, coverage: &[u8]) {
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.coverage,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            coverage,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(COVERAGE_BUCKETS as u32),
                rows_per_image: Some(1),
            },
            wgpu::Extent3d { width: COVERAGE_BUCKETS as u32, height: 1, depth_or_array_layers: 1 },
        );
    }

    pub fn render(&mut self, osd: &Osd) {
        let frame = match self.surface.get_current_texture() {
            Ok(frame) => frame,
            Err(wgpu::SurfaceError::Outdated | wgpu::SurfaceError::Lost) => {
                self.surface.configure(&self.device, &self.config);
                return;
            }
            Err(_) => return,
        };
        let view = frame.texture.create_view(&Default::default());
        let mut encoder = self.device.create_command_encoder(&Default::default());
        self.draw(&mut encoder, &view, osd);
        self.queue.submit([encoder.finish()]);
        frame.present();
    }

    fn draw(&self, encoder: &mut wgpu::CommandEncoder, view: &wgpu::TextureView, osd: &Osd) {
        let (screen_w, screen_h) = (self.config.width as f64, self.config.height as f64);
        let screen_aspect = screen_w / screen_h;
        let rect = if screen_aspect > self.aspect {
            let w = self.aspect / screen_aspect;
            [(1.0 - w) / 2.0, 0.0, (1.0 + w) / 2.0, 1.0]
        } else {
            let h = screen_aspect / self.aspect;
            [0.0, (1.0 - h) / 2.0, 1.0, (1.0 + h) / 2.0]
        };
        let uniforms = Uniforms {
            rect: rect.map(|value| value as f32),
            osd: [osd.alpha, osd.played, if self.has_frame { 1.0 } else { 0.0 }, if self.bt601 { 1.0 } else { 0.0 }],
            screen: [screen_w as f32, screen_h as f32, self.scale, 0.0],
        };
        self.queue.write_buffer(&self.uniforms, 0, bytemuck::bytes_of(&uniforms));
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("video"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                resolve_target: None,
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
        });
        if let Some((_, _, bind_group)) = &self.planes {
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, bind_group, &[]);
            pass.draw(0..3, 0..1);
        }
    }

    /// Renders what the window would show into a PPM file (diagnostics:
    /// proves the picture without a screen capture).
    pub fn snapshot(&self, osd: &Osd, path: &std::path::Path) -> Result<()> {
        let (width, height) = (self.config.width, self.config.height);
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("snapshot"),
            size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.config.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let row = (width * 4).div_ceil(256) * 256;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("snapshot"),
            size: (row * height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self.device.create_command_encoder(&Default::default());
        self.draw(&mut encoder, &texture.create_view(&Default::default()), osd);
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: Some(height) },
            },
            wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
        );
        self.queue.submit([encoder.finish()]);
        let slice = buffer.slice(..);
        slice.map_async(wgpu::MapMode::Read, |_| {});
        self.device.poll(wgpu::Maintain::Wait);
        let data = slice.get_mapped_range();
        let bgra = matches!(self.config.format, wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb);
        let mut ppm = format!("P6\n{width} {height}\n255\n").into_bytes();
        for y in 0..height {
            for x in 0..width {
                let at = (y * row + x * 4) as usize;
                let pixel = &data[at..at + 4];
                if bgra {
                    ppm.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
                } else {
                    ppm.extend_from_slice(&pixel[..3]);
                }
            }
        }
        std::fs::write(path, ppm)?;
        Ok(())
    }
}

const SHADER: &str = r#"
struct U { rect: vec4<f32>, osd: vec4<f32>, screen: vec4<f32> };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var luma: texture_2d<f32>;
@group(0) @binding(2) var chroma: texture_2d<f32>;
@group(0) @binding(3) var coverage: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;

struct VOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32> };

@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  var o: VOut;
  o.pos = vec4(p[i], 0.0, 1.0);
  o.uv = vec2((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
  return o;
}

@fragment fn fs(in: VOut) -> @location(0) vec4<f32> {
  let uv = in.uv;
  let t = clamp((uv - u.rect.xy) / (u.rect.zw - u.rect.xy), vec2(0.0), vec2(1.0));
  let y = (textureSampleLevel(luma, samp, t, 0.0).r - 16.0 / 255.0) * (255.0 / 219.0);
  let c = (textureSampleLevel(chroma, samp, t, 0.0).rg - vec2(128.0 / 255.0)) * (255.0 / 224.0);
  var rgb: vec3<f32>;
  if (u.osd.w > 0.5) {
    rgb = vec3(y + 1.402 * c.y, y - 0.344136 * c.x - 0.714136 * c.y, y + 1.772 * c.x);
  } else {
    rgb = vec3(y + 1.5748 * c.y, y - 0.1873 * c.x - 0.4681 * c.y, y + 1.8556 * c.x);
  }
  let inside = u.osd.z > 0.5 && uv.x >= u.rect.x && uv.x <= u.rect.z && uv.y >= u.rect.y && uv.y <= u.rect.w;
  var color = select(vec3(0.0), clamp(rgb, vec3(0.0), vec3(1.0)), inside);

  let a = u.osd.x;
  if (a > 0.0) {
    let px = uv * u.screen.xy;
    let s = u.screen.z;
    color = mix(color, vec3(0.0), smoothstep(u.screen.y - 140.0 * s, u.screen.y, px.y) * 0.65 * a);
    let margin = 28.0 * s;
    let top = u.screen.y - 34.0 * s;
    let height = 5.0 * s;
    if (px.x >= margin && px.x <= u.screen.x - margin && px.y >= top && px.y <= top + height) {
      let f = (px.x - margin) / (u.screen.x - 2.0 * margin);
      let cached = textureSampleLevel(coverage, samp, vec2(f, 0.5), 0.0).r;
      var bar = mix(vec3(0.22), vec3(0.55), cached);
      if (f <= u.osd.y) { bar = vec3(1.0); }
      color = mix(color, bar, a);
    }
  }
  return vec4(color, 1.0);
}
"#;
