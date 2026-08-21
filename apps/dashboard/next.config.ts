import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  ...(process.env.BUILD_STANDALONE === "true" ? { output: "standalone" as const } : {}),
  async headers() {
    const apiOrigin = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";
    const values = [
      { key: "Content-Security-Policy", value: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ${apiOrigin}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'` },
      { key: "X-Content-Type-Options", value: "nosniff" }, { key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Frame-Options", value: "DENY" }
    ];
    if (process.env.NODE_ENV === "production") values.push({ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" });
    return [{ source: "/(.*)", headers: values }];
  }
};

export default nextConfig;
