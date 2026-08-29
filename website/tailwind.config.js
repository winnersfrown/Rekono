/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      // Every colour is a CSS custom property, not a literal, so the token
      // system defined once in src/index.css (and mirrored in the product's
      // backend/public/styles.css) stays the single source of truth. These
      // entries only give Tailwind's utilities (bg-, text-, border-, ...) a
      // name for each one. See DESIGN.md.
      colors: {
        paper: {
          DEFAULT: "var(--paper)",
          sunk: "var(--paper-sunk)",
          rise: "var(--paper-rise)",
        },
        ink: {
          DEFAULT: "var(--ink)",
          soft: "var(--ink-soft)",
        },
        muted: "var(--muted)",
        rule: {
          DEFAULT: "var(--rule)",
          soft: "var(--rule-soft)",
        },
        accent: {
          DEFAULT: "var(--accent)",
          deep: "var(--accent-deep)",
          text: "var(--accent-text)",
          ink: "var(--accent-ink)",
          wash: "var(--accent-wash)",
        },
        pos: "var(--pos)",
        neg: "var(--neg)",
      },
      fontFamily: {
        display: ["Bitter", "Georgia", "Times New Roman", "serif"],
        body: ["IBM Plex Sans", "-apple-system", "BlinkMacSystemFont", "Segoe UI", "sans-serif"],
        mono: ["IBM Plex Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      // The 4px scale from DESIGN.md, named so "spacious" is checkable
      // instead of a feeling. 2xl/3xl/4xl are the ones that matter: 96px
      // between marketing sections, 32px inside a panel.
      spacing: {
        "2xs": "var(--sp-2xs)",
        xs: "var(--sp-xs)",
        sm: "var(--sp-sm)",
        md: "var(--sp-md)",
        lg: "var(--sp-lg)",
        xl: "var(--sp-xl)",
        "2xl": "var(--sp-2xl)",
        "3xl": "var(--sp-3xl)",
        "4xl": "var(--sp-4xl)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius-md)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
      },
      boxShadow: {
        // The only shadow in the system, for the only genuinely floating
        // layer (the contact modal). Everything else is ruled.
        modal: "var(--shadow-modal)",
      },
      maxWidth: {
        content: "1320px",
        measure: "34rem",
      },
      transitionTimingFunction: {
        brand: "cubic-bezier(0.22, 1, 0.36, 1)",
      },
    },
  },
  plugins: [],
};
