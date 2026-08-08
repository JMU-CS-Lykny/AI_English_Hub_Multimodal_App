import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  async redirects() {
    return [
      {
        source: "/teacher/classrooms",
        destination: "/home?tab=classrooms",
        permanent: false,
      },
      {
        source: "/student/classrooms",
        destination: "/home?tab=classrooms",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
