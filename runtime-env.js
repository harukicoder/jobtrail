(function initJobTrailRuntimeEnv(global) {
  const isExtension = Boolean(
    global.chrome &&
    global.chrome.runtime &&
    global.chrome.runtime.id &&
    String(global.location && global.location.protocol || "").startsWith("chrome-extension")
  );

  global.JOBTRAIL_RUNTIME = {
    isExtension
  };

  if (isExtension) return;

  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.defer = true;
  document.head.appendChild(script);
})(window);
