(function () {
  var links = [["Rules", "/rules"], ["Albums", "/"], ["Sort albums", "/sort"], ["Check all", "/plan"], ["Status", "/status"], ["New rule", "/rule"]];
  var bar = document.createElement("nav");
  bar.className = "topbar";
  var brand = document.createElement("a");
  brand.className = "brand";
  brand.href = "/rules";
  var smith = document.createElement("b");
  smith.textContent = "smith";
  brand.append("Album", smith);
  bar.append(brand);
  var path = location.pathname.replace(/\/$/, "") || "/";
  links.forEach(function (l) {
    var a = document.createElement("a");
    a.href = l[1];
    a.textContent = l[0];
    var editing = path === "/rule" && new URLSearchParams(location.search).has("key");
    var here = editing ? "/rules" : path;
    if (l[1] === here) a.className = "current";
    bar.append(a);
  });
  var out = document.createElement("a");
  out.href = "/";
  out.addEventListener("click", function (e) {
    e.preventDefault();
    fetch("/auth/logout", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .finally(function () { location.href = "/"; });
  });
  out.textContent = "Log out";
  out.className = "logout";
  bar.append(out);
  document.body.prepend(bar);

  function addFooter() {
    var f = document.createElement("footer");
    f.className = "site-foot";
    f.textContent = "Albumsmith. This product uses the Flickr API but is not endorsed or certified by SmugMug, Inc.";
    document.body.append(f);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", addFooter);
  else addFooter();
})();

;(function(){var t='<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg"><link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32.png"><link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">';document.head.insertAdjacentHTML('beforeend',t);})();

;(function () {
  function showVersion() {
    fetch("/api/version").then((r) => (r.ok ? r.json() : null)).then((d) => {
      const f = document.querySelector("footer.site-foot");
      if (!d || !f || f.querySelector(".ver")) return;
      const s = document.createElement("div");
      s.className = "ver";
      s.textContent = "Albumsmith v" + d.version;
      f.append(s);
    }).catch(() => {});
  }
  if (document.readyState === "complete") showVersion();
  else window.addEventListener("load", showVersion);
})();
