/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@marktape/core"],
  images: { remotePatterns: [{ protocol: "https", hostname: "**" }] },
};

export default nextConfig;
