(function () {
  try {
    var stored = JSON.parse(window.localStorage.getItem("cw-code:theme") || "null");
    if (!stored || typeof stored !== "object") return;
    var root = document.documentElement;
    var light = stored.mode === "light" || (stored.mode === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
    var base = light ? "light" : "dark";
    root.dataset.theme = base;
    root.style.colorScheme = base;
    var vars = stored.vars && typeof stored.vars === "object" ? stored.vars : {};
    var names = [];
    for (var name in vars) {
      if (Object.prototype.hasOwnProperty.call(vars, name) && /^[a-z0-9-]+$/.test(name) && typeof vars[name] === "string") {
        root.style.setProperty("--" + name, vars[name]);
        names.push(name);
      }
    }
    if (names.length > 0) root.setAttribute("data-theme-vars", names.join(" "));
    if (typeof vars.gutter === "string") root.style.backgroundColor = vars.gutter;
  } catch (e) {}
})();
