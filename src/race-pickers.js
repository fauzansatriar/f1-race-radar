function initializeRacePickers() {
  const dialog = $("race-picker");
  const list = $("picker-options");
  let trigger = null;

  const position = () => {
    if (!dialog.open || !trigger) return;
    if (!trigger.getClientRects().length) {
      dialog.close();
      return;
    }
    if (mobileLayout.matches) return;
    const rect = trigger.getBoundingClientRect();
    const width = dialog.offsetWidth;
    const height = dialog.offsetHeight;
    const x = clamp(rect.left, 8, Math.max(8, innerWidth - width - 8));
    const y = rect.bottom + height + 8 <= innerHeight
      ? rect.bottom + 8
      : clamp(rect.top - height - 8, 8, Math.max(8, innerHeight - height - 8));
    dialog.style.setProperty("--picker-left", `${x}px`);
    dialog.style.setProperty("--picker-top", `${y}px`);
  };

  function open(button, kind) {
    trigger = button;
    const lapPicker = kind === "lap";
    dialog.dataset.kind = kind;
    text("picker-title", lapPicker ? "Jump to lap" : "Race battles");
    list.classList.toggle("lap-options", lapPicker);
    list.innerHTML = lapPicker
      ? lapOptions(button.value)
      : battleOptions(battlesAt(fieldAt(state.time)), button.value);
    if (!list.children.length) return;
    button.setAttribute("aria-expanded", "true");
    dialog.showModal();
    position();
    const selected = list.querySelector('[aria-selected="true"]') ?? list.firstElementChild;
    focusPickerOption(selected);
    if (selected.offsetTop + selected.offsetHeight > list.clientHeight) {
      list.scrollTop = selected.offsetTop - (list.clientHeight - selected.offsetHeight) / 2;
    }
  }

  $("battle-select").addEventListener("click", (event) => open(event.currentTarget, "battle"));
  $("lap-select").addEventListener("click", (event) => open(event.currentTarget, "lap"));
  $("close-picker").addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => {
    trigger?.setAttribute("aria-expanded", "false");
    if (trigger && !trigger.disabled && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
    trigger = null;
  });
  list.addEventListener("click", (event) => {
    const option = event.target.closest("[role=option]");
    if (!option || !trigger) return;
    const value = option.dataset.value;
    const target = trigger;
    dialog.close();
    if (dialog.dataset.kind === "battle" && !battlesAt(fieldAt(state.time)).some((entry) => String(entry.b.number) === value)) return;
    target.value = value;
    target.dispatchEvent(new Event("change", { bubbles: true }));
  });
  list.addEventListener("keydown", (event) => {
    const items = [...list.children];
    const index = items.indexOf(event.target);
    if (index === -1) return;
    const columns = list.classList.contains("lap-options")
      ? getComputedStyle(list).gridTemplateColumns.split(" ").length : 1;
    const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns }[event.key];
    if (offset === undefined && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : clamp(index + offset, 0, items.length - 1);
    focusPickerOption(items[next]);
    items[next].scrollIntoView({ block: "nearest" });
  });
  window.addEventListener("resize", position);
}

function focusPickerOption(option) {
  const prior = option.parentElement.querySelector('[tabindex="0"]');
  if (prior) prior.tabIndex = -1;
  option.tabIndex = 0;
  option.focus({ preventScroll: true });
}

function battleOptions(battles, selected) {
  const racer = (driver) => `<span class="picker-racer">
    <i style="--racer-color: ${driver.color}"></i><small>#${driver.number}</small><strong>${escapeHtml(driver.code)}</strong>
  </span>`;
  const check = '<svg class="picker-check" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m3 8 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return battles.map(({ position, a, b }) => `
    <button class="picker-option picker-battle" type="button" role="option" tabindex="-1"
      aria-selected="${String(b.number) === selected}" data-value="${b.number}"
      aria-label="P${position}, ${escapeHtml(a.name)} versus ${escapeHtml(b.name)}">
      <span class="picker-rank">P${position}</span>${racer(a)}<small class="picker-versus">VS</small>${racer(b)}${check}
    </button>`).join("");
}

function lapOptions(selected) {
  const rows = state.laps.map(([, lap]) => `
    <button class="picker-option picker-lap" type="button" role="option" tabindex="-1" aria-label="Lap ${lap}"
      aria-selected="${String(lap) === selected}" data-value="${lap}">${String(lap).padStart(2, "0")}</button>`);
  rows.push(`<button class="picker-option picker-finish" type="button" role="option" tabindex="-1"
    aria-selected="${selected === "finish"}" data-value="finish">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 2v12m1-11h9v7H4m0-4h9M7 3v7m3-7v7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
      Finish
    </button>`);
  return rows.join("");
}
