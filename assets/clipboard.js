(function () {
  // 原有功能：pre 点击聚焦 + Ctrl+C 复制
  document.querySelectorAll("pre:has(code)").forEach(code => {
    code.addEventListener("click", code.focus);
    code.addEventListener("copy", function (event) {
      event.preventDefault();
      if (navigator.clipboard) {
        const content = window.getSelection().toString() || code.textContent;
        navigator.clipboard.writeText(content);
      }
    });
  });

  // 为带文件名的代码块注入复制按钮
  document.querySelectorAll(".book-codeblock-filename").forEach(filename => {
    const { header, actions, btn } = createHeader();
    filename.parentNode.insertBefore(header, filename);
    header.appendChild(filename);
    header.appendChild(actions);
    // 检查 copy="false" 属性，隐藏复制按钮
    const pre = findPre(header);
    if (pre && isCopyDisabled(header)) btn.style.display = "none";
    // 检查 collapse="true" 属性，注入折叠按钮（默认只显示第 1 行）
    initCollapse(header, actions, btn);
  });

  // 为没有文件名但有语言类型的代码块注入语言标签和复制按钮
  document.querySelectorAll(".highlight").forEach(highlight => {
    const prev = highlight.previousElementSibling;
    if (prev && prev.classList.contains("book-codeblock-header")) return;
    const code = highlight.querySelector("code[class*='language-']");
    if (!code) return;
    const lang = code.className.match(/language-(\w+)/);
    if (!lang) return;

    const label = document.createElement("code");
    label.className = "book-codeblock-filename";
    label.textContent = lang[1];
    const { header, actions, btn } = createHeader();
    header.appendChild(label);
    header.appendChild(actions);
    highlight.parentNode.insertBefore(header, highlight);
    // 检查 copy="false" 属性，隐藏复制按钮
    const pre = findPre(header);
    if (pre && isCopyDisabled(header)) btn.style.display = "none";
    // 检查 collapse="true" 属性，注入折叠按钮（默认只显示第 1 行）
    initCollapse(header, actions, btn);
  });

  /** 创建带复制按钮的文件名栏 */
  function createHeader() {
    const header = document.createElement("div");
    header.className = "book-codeblock-header";

    // 右侧按钮组：折叠按钮会插到复制按钮左边
    const actions = document.createElement("span");
    actions.className = "book-codeblock-actions";

    const btn = document.createElement("button");
    btn.className = "book-codeblock-copy";
    btn.textContent = "复制";
    btn.title = "复制代码";
    btn.addEventListener("click", function () {
      const next = header.nextElementSibling;
      const targetPre = next && next.tagName === "PRE" ? next : next && next.querySelector("pre");
      if (targetPre) {
        navigator.clipboard.writeText(targetPre.textContent).then(() => {
          btn.textContent = "已复制";
          setTimeout(() => { btn.textContent = "复制"; }, 2000);
        });
      }
    });
    actions.appendChild(btn);
    return { header, actions, btn };
  }

  /** 折叠模式：collapse="true" 时注入"折叠/展开"按钮，默认只显示前几行（末行渐隐） */
  function initCollapse(header, actions, copyBtn) {
    if (!isCollapseEnabled(header)) return;

    const block = header.nextElementSibling;
    if (!block) return;

    // Chroma 把每行渲染成一个 span，行数用作"下面还有内容"的提示
    const lineCount = block.querySelectorAll("pre code > span").length;

    // 折叠时才显示的行数提示
    const hint = document.createElement("span");
    hint.className = "book-codeblock-lines";

    const btn = document.createElement("button");
    btn.className = "book-codeblock-collapse";
    btn.type = "button";

    let folded = true;
    function apply() {
      block.classList.toggle("book-codeblock-folded", folded);
      btn.textContent = folded ? "展开" : "折叠";
      btn.title = folded ? "展开全部代码" : "折叠代码（只显示前几行）";
      btn.setAttribute("aria-expanded", folded ? "false" : "true");
      hint.textContent = lineCount > 1 ? "共 " + lineCount + " 行" : "";
      hint.style.display = folded && lineCount > 1 ? "" : "none";
    }
    btn.addEventListener("click", function () {
      folded = !folded;
      apply();
    });

    // 放在复制按钮左边
    actions.insertBefore(hint, copyBtn);
    actions.insertBefore(btn, copyBtn);
    apply();
  }

  /** 从 header 找到关联的 pre 元素 */
  function findPre(header) {
    const next = header.nextElementSibling;
    return next && next.tagName === "PRE" ? next : next && next.querySelector("pre");
  }

  /** 检查代码块是否设置了 copy="false" */
  function isCopyDisabled(header) {
    const next = header.nextElementSibling;
    if (!next) return false;
    // 检查 .highlight 或 pre 上的 copy 属性
    if (next.getAttribute("copy") === "false") return true;
    const pre = next.tagName === "PRE" ? next : next.querySelector("pre");
    if (pre && pre.getAttribute("copy") === "false") return true;
    return false;
  }

  /** 读取代码块上的 collapse 属性（写在 .highlight 或 pre 上） */
  function isCollapseEnabled(header) {
    const next = header.nextElementSibling;
    if (!next) return false;
    const targets = [next, next.tagName === "PRE" ? next : next.querySelector("pre")];
    for (const el of targets) {
      if (!el || !el.hasAttribute("collapse")) continue;
      const value = String(el.getAttribute("collapse")).trim().toLowerCase();
      // 无值或 true/yes/on 视为开启；false/0/no/off 视为关闭
      return !["false", "0", "no", "off"].includes(value);
    }
    return false;
  }
})();