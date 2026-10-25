(() => {
  const actions = document.querySelector(".heading-actions");
  if (!actions) return;

  const style = document.createElement("style");
  style.textContent = `
    .enrollment-dialog{width:min(92vw,560px);border:1px solid #dce2ed;border-radius:16px;padding:24px;color:#172033;box-shadow:0 24px 80px #10182740}
    .enrollment-dialog::backdrop{background:#10182799}
    .enrollment-dialog h2{margin:0 0 8px;font-size:20px}
    .enrollment-dialog p{font-size:13px;line-height:1.6;color:#64748b}
    .enrollment-token{display:block;width:100%;padding:13px;border:1px solid #dce2ed;border-radius:8px;background:#f5f7fb;color:#172033;font:12px ui-monospace,monospace;overflow-wrap:anywhere;user-select:all}
    .enrollment-dialog-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:18px}
    .enrollment-dialog-actions .button{flex:0 1 auto}
    .enrollment-warning{padding:10px 12px;background:#fff5df;border-radius:8px;color:#8a6117!important}
  `;
  document.head.appendChild(style);

  const button = document.createElement("button");
  button.className = "button button-primary";
  button.id = "createEnrollmentTokenButton";
  button.type = "button";
  button.textContent = "＋ Enroll device";
  actions.prepend(button);

  const dialog = document.createElement("dialog");
  dialog.className = "enrollment-dialog";
  dialog.setAttribute("aria-labelledby", "enrollmentDialogTitle");
  dialog.innerHTML = `
    <h2 id="enrollmentDialogTitle">One-time enrollment token</h2>
    <p id="enrollmentDialogStatus">Create a token to enroll one test Windows device. It expires in 24 hours and can be used once.</p>
    <code id="enrollmentTokenValue" class="enrollment-token" hidden></code>
    <p id="enrollmentExpiry"></p>
    <p class="enrollment-warning">Treat this token like a password. It is shown only once. Do not paste it into chat, tickets, or screenshots.</p>
    <div class="enrollment-dialog-actions">
      <button id="copyEnrollmentTokenButton" class="button button-secondary" type="button" hidden>Copy token</button>
      <button id="closeEnrollmentDialogButton" class="button button-primary" type="button">Close</button>
    </div>`;
  document.body.appendChild(dialog);

  const status = dialog.querySelector("#enrollmentDialogStatus");
  const tokenValue = dialog.querySelector("#enrollmentTokenValue");
  const expiry = dialog.querySelector("#enrollmentExpiry");
  const copyButton = dialog.querySelector("#copyEnrollmentTokenButton");
  const closeButton = dialog.querySelector("#closeEnrollmentDialogButton");

  closeButton.addEventListener("click", () => dialog.close());
  copyButton.addEventListener("click", async () => {
    const token = tokenValue.textContent;
    try {
      await navigator.clipboard.writeText(token);
      status.textContent = "Token copied. Store it securely; it will not be shown again after closing.";
    } catch (_error) {
      status.textContent = "Clipboard access was blocked. Select the token text and copy it manually.";
    }
  });

  button.addEventListener("click", async () => {
    if (!accessToken) {
      showAuthGate("Sign in with your workspace administrator account.");
      return;
    }
    button.disabled = true;
    button.textContent = "Creating token…";
    status.textContent = "Requesting a single-use token from the server…";
    tokenValue.hidden = true;
    tokenValue.textContent = "";
    expiry.textContent = "";
    copyButton.hidden = true;
    closeButton.textContent = "Close";
    dialog.showModal();
    try {
      const response = await fetch("/api/admin/enrollment-tokens", {
        method: "POST",
        headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" }
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create an enrollment token.");
      tokenValue.textContent = data.token;
      tokenValue.hidden = false;
      expiry.textContent = "Expires: " + new Date(data.expiresAt).toLocaleString();
      copyButton.hidden = false;
      status.textContent = "Token created successfully. Use it on exactly one test device.";
    } catch (error) {
      status.textContent = error.message || "Could not create an enrollment token.";
      expiry.textContent = "";
    } finally {
      button.disabled = false;
      button.textContent = "＋ Enroll device";
    }
  });
})();
