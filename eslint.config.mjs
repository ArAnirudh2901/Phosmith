import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

const eslintConfig = defineConfig([
  ...nextVitals,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Not our code: the Python virtualenv ships .js/.mjs assets (matplotlib,
    // torch) and .cache holds the bun-built client-ai harness bundle.
    "services/segment/.venv/**",
    ".cache/**",
  ]),
  {
    rules: {
      // React Compiler strict-mode rules. These produce false positives on
      // legitimate patterns we use: deliberate mutations of external Fabric.js
      // canvas instances, async setState in effects, r3f ref usage. Re-enable
      // individually when/if we adopt React Compiler optimization.
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
]);

export default eslintConfig;
