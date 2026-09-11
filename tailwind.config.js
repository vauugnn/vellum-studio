/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/renderer/**/*.{html,jsx,js}"],
  theme: {
    extend: {
      colors: {
        // Graphite and warm ivory: the palette of a drawing tool rather than a
        // utility. Named by role so the HUD and the panel stay in step.
        ink: {
          900: "#100f14",
          800: "#16151a",
          700: "#1d1c23",
          600: "#26242e",
          500: "#332f3d",
          400: "#4a4557",
        },
        vellum: {
          100: "#f4efe6",
          200: "#e3dbcc",
          300: "#c9bfab",
          400: "#9c9384",
        },
        nib: "#c8a35e",
        live: "#6fbf8b",
        held: "#d8a657",
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "SF Pro Text", "sans-serif"],
        mono: ["SF Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
