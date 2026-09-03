/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          // Control-room neutrals: cooler and more separated than before so
          // nested surfaces (page < rail < card < popover) read as layers.
          950: "#06090e",
          900: "#0b0f16",
          850: "#0f141c",
          800: "#141a24",
          700: "#1e2632",
          600: "#2c3544",
          500: "#3d4759",
        },
        airlock: {
          // signal color: a brighter, cleaner teal-cyan for the "sealed" theme
          300: "#8df0e2",
          400: "#4ce0cd",
          500: "#1dbbac",
          600: "#129488",
          700: "#0d6f66",
        },
        // semantic — each means exactly one thing (unchanged by the retheme)
        pending: "#f5a623", // a proposal awaiting human approval
        commit: "#3dd68c", // a change that has been applied
        danger: "#e5575c", // reject / destructive
      },
      boxShadow: {
        lift: "0 10px 28px -14px rgb(0 0 0 / 0.65)",
        glow: "0 0 26px -8px rgb(76 224 205 / 0.4)",
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
        sans: [
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
      },
      keyframes: {
        "commit-flash": {
          "0%": { backgroundColor: "rgba(61,214,140,0.18)" },
          "100%": { backgroundColor: "transparent" },
        },
        "pending-pulse": {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
        "slide-in": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "commit-flash": "commit-flash 1.2s ease-out",
        "pending-pulse": "pending-pulse 2s ease-in-out infinite",
        "slide-in": "slide-in 0.18s ease-out",
      },
    },
  },
  plugins: [],
};
