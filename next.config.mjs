/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["jsmediatags"],
  images: { unoptimized: true },
  experimental: {
    serverComponentsExternalPackages: ["yt-dlp-wrap"],
  },
  webpack: (config) => {
    // jsmediatags bundles a React Native reader that statically requires
    // react-native-fs; it's never used in the browser, so stub it out.
    config.resolve.alias = {
      ...config.resolve.alias,
      "react-native-fs": false,
    };
    return config;
  },
};

export default nextConfig;
