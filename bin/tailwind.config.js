/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./bin/public/**/*.html", "./bin/public/**/*.js"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "ec-bg":      "#080b12",
        "ec-surface": "#0f1623",
        "ec-border":  "#1e2d45",
        "ec-yes":     "#00c076",
        "ec-no":      "#ff4d4f",
        "ec-accent":  "#3b82f6",
      },
    },
  },
};
