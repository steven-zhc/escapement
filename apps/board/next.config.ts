import type { NextConfig } from "next";

const config: NextConfig = {
  // Localhost, one user. See doc/decisions/0008-nextjs.md for why there is no
  // auth here and what has to change before that stops being true.
  // Every workspace package the board reaches. They ship as TypeScript source
  // with no build step (doc/decisions/0010), so Turbopack compiles them here.
  transpilePackages: [
    "@escapement/conductor",
    "@escapement/config",
    "@escapement/core",
    "@escapement/env",
    "@escapement/github",
    "@escapement/store",
  ],
};

export default config;
