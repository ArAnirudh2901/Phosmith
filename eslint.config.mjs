import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import * as espree from "espree";

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
    "services/masking/.venv/**",
    ".cache/**",
    // Standalone create-next-app scaffold (TypeScript), not part of this app.
    "clerk-nextjs/**",
    "graphify-out/**",
  ]),
  // Next's bundled Babel parser ships an eslint-scope without addGlobals, which
  // crashes ESLint 10 on every file. espree parses our JS/JSX natively.
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    languageOptions: {
      parser: espree,
      parserOptions: { ecmaVersion: "latest", sourceType: "module", ecmaFeatures: { jsx: true } },
    },

  },
  // "detect" calls context.getFilename, removed in ESLint 10.
  { settings: { react: { version: "19.2.7" } } },
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
