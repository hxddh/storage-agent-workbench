export default {
  plugins: {
    // Tailwind 4 ships its PostCSS plugin as a separate package; the old
    // `tailwindcss: {}` entry is a hard error in v4.
    "@tailwindcss/postcss": {},
    autoprefixer: {},
  },
};
