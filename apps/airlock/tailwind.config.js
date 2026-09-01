/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0a0c10",
          900: "#0f1219",
          850: "#12161f",
          800: "#161b24",
          700: "#1e2430",
          600: "#2a3140",
          500: "#3a4354",
        },
        airlock: {
          // signal color: a calm, trustworthy teal-cyan for the "sealed" theme
          300: "#7fe9dc",
          400: "#3dd7c4",
          500: "#17b3a3",
          600: "#0e8d80",
          700: "#0b6b62",
        },
        // semantic — each means exactly one thing
        pending: "#f5a623", // a proposal awaiting human approval
        commit: "#3dd68c", // a change that has been applied
        danger: "#e5575c", // reject / destructive
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
