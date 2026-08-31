import type { NextConfig } from "next";

const config: NextConfig = {
  // Localhost, one user. See doc/decisions/0008-nextjs.md for why there is no
  // auth here and what has to change before that stops being true.
  transpilePackages: ["@escapement/core", "@escapement/store"],
};

export default config;
