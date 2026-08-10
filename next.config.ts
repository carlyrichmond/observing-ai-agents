import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // openlit uses OTel monkey-patching which requires native require();
  // bundling it would break instrumentation under Next 16's Turbopack build.
  serverExternalPackages: ['openlit'],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "cdn.weatherapi.com",
        port: "",
        pathname: "/weather/64x64/*/*.png",
        search: ""
      }
    ]
  }
};

export default nextConfig;
