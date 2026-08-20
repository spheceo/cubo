import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@cubo/core', '@cubo/ui'],
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'image.tmdb.org',
      },
    ],
  },
};

export default nextConfig;
