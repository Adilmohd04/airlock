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
        // One step up from `lift` — for the Model Center and other modal-grade
        // surfaces that float above popovers, not just above the rail.
        popover: "0 24px 60px -20px rgb(0 0 0 / 0.75), 0 0 0 1px rgb(255 255 255 / 0.04)",
      },
      fontFamily: {
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Consolas",
          "monospace",
        ],
        // System stack, deliberately — see index.css header for why this isn't
        // a self-hosted webfont. Ordered so each platform gets its native
        // grotesque (SF on macOS, Segoe on Windows) instead of a shared web font.
        sans: [
          "-apple-system",
          "system-ui",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
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
        "scale-in": {
          from: { opacity: "0", transform: "scale(0.97) translateY(6px)" },
          to: { opacity: "1", transform: "scale(1) translateY(0)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
      animation: {
        "commit-flash": "commit-flash 1.2s ease-out",
        "pending-pulse": "pending-pulse 2s ease-in-out infinite",
        "slide-in": "slide-in 0.18s ease-out",
        "scale-in": "scale-in 0.16s cubic-bezier(0.16, 1, 0.3, 1)",
        "fade-in": "fade-in 0.15s ease-out",
      },
    },
  },
  plugins: [],
};
