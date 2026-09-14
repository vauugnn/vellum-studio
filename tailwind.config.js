/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/renderer/**/*.{html,jsx,js}"],
  theme: {
    extend: {
      // The palette by role. Five greys carry the whole interface. The two
      // pigments carry meaning and nothing else: ultramarine for whatever is
      // live, selected or focused, vermilion only for loss. Amber belongs to the
      // mark and never appears inside the app.
      colors: {
        pitch: "#0E0F11",     // wells, recesses
        graphite: "#17181A",  // app ground
        panel: "#202327",     // rails, sheets
        seam: "#2C2F34",      // dividers within a surface
        edge: "#3A3E44",      // hairlines, control borders
        dust: "#8A9099",      // secondary text
        ash: "#A8AEB6",       // body copy
        chalk: "#F2F3F5",     // primary text
        ultra: { DEFAULT: "#4459E0", deep: "#3245C4", text: "#8EA0FF" },
        vermilion: "#D8452C",
      },
      fontFamily: {
        sans: ["Archivo", "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "monospace"],
      },
      // The four sizes the brief names, as size/leading pairs.
      fontSize: {
        rail: ["11px", "14px"],
        body: ["13px", "18px"],
        dialog: ["15px", "22px"],
        empty: ["28px", "30px"],
      },
      // Milled, not moulded: near-square corners on every control.
      borderRadius: { DEFAULT: "2px" },
      // The one permitted shadow, for floating sheets only.
      boxShadow: { sheet: "0 8px 24px rgba(0, 0, 0, 0.4)" },
      transitionDuration: { DEFAULT: "100ms" },
    },
  },
  plugins: [],
};
