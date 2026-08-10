import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Turbopack's package-lock.json lookup walks up from the project root.
  // Without this, it finds ~/.package-lock.json (outside the git repo) and warns.
  turbopack: {
    root: __dirname,
  },
  // openlit uses OTel monkey-patching which requires native require();
  // bundling it would break instrumentation under Next 16's Turbopack build.
  // @opentelemetry/api must also be external so that openlit, @ai-sdk/otel, and
  // route.ts all share the same physical module — required for the global
  // tracer/logger provider registered by openlit.init() to be visible to all callers.
  serverExternalPackages: ['openlit', '@opentelemetry/api'],
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
