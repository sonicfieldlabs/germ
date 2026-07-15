(() => {
  const root = document.documentElement;
  const storedTheme = localStorage.getItem("germinator-theme");
  const storedAccent = localStorage.getItem("germinator-accent");
  const theme = storedTheme === "dark" || storedTheme === "light"
    ? storedTheme
    : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const accent = /^#[0-9a-f]{6}$/i.test(storedAccent || "") ? storedAccent : "#476f5d";

  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  root.style.setProperty("--germ-accent", accent);

  window.addEventListener("storage", (event) => {
    if (event.key === "germinator-theme" && (event.newValue === "dark" || event.newValue === "light")) {
      root.dataset.theme = event.newValue;
      root.style.colorScheme = event.newValue;
    }
    if (event.key === "germinator-accent" && /^#[0-9a-f]{6}$/i.test(event.newValue || "")) {
      root.style.setProperty("--germ-accent", event.newValue);
    }
  });
})();
