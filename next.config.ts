import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // O2C.1 — the staging Okta JWKS artifact. Served as a STATIC file from `public/`, so the serving path holds no AWS
        // credentials and cannot call kms:Sign even if compromised. That containment is the main reason a pre-generated artifact
        // was chosen over a dynamic route.
        //
        // Next serves `public/` with `Cache-Control: public, max-age=0` by default, which would defeat caching entirely, so the
        // policy is set explicitly here. 300s is DELIBERATELY conservative: Okta's JWKS refresh behaviour is undocumented, and
        // this value stays provisional until O2C.2 measures it. `must-revalidate` keeps rotation safe.
        source: "/.well-known/idcaddie-okta-jwks.json",
        headers: [
          { key: "Content-Type", value: "application/json" },
          { key: "Cache-Control", value: "public, max-age=300, must-revalidate" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
