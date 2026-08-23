/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      // Every color is a CSS custom property, not a literal, so the token
      // system defined once in src/index.css stays the single source of
      // truth -- these entries just give Tailwind's utility classes (bg-,
      // text-, border-, ...) a name for each one.
      colors: {
        ink: {
          950: "var(--ink-950)",
          900: "var(--ink-900)",
          850: "var(--ink-850)",
          800: "var(--ink-800)",
        },
        line: "var(--line)",
        "line-soft": "var(--line-soft)",
        paper: "var(--paper)",
        "paper-dim": "var(--paper-dim)",
        muted: "var(--muted)",
        blue: {
          DEFAULT: "var(--blue)",
          bright: "var(--blue-bright)",
          deep: "var(--blue-deep)",
        },
        amber: "var(--amber)",
        green: "var(--green)",
      },
      fontFamily: {
        display: ["Bitter", "Georgia", "serif"],
        body: ["IBM Plex Sans", "-apple-system", "sans-serif"],
        mono: ["IBM Plex Mono", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        sm: "var(--shadow-sm)",
        md: "var(--shadow-md)",
        lg: "var(--shadow-lg)",
        glow: "var(--shadow-glow)",
        glass: "var(--glass-shadow)",
      },
      maxWidth: {
        content: "1320px",
      },
      transitionTimingFunction: {
        brand: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
};
