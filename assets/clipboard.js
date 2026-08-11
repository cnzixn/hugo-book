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
    const { header, btn } = createHeader();
    filename.parentNode.insertBefore(header, filename);
    header.appendChild(filename);
    header.appendChild(btn);
    // 检查 copy="false" 属性，隐藏复制按钮
    const pre = findPre(header);
    if (pre && isCopyDisabled(header)) btn.style.display = "none";
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
    const { header, btn } = createHeader();
    header.appendChild(label);
    header.appendChild(btn);
    highlight.parentNode.insertBefore(header, highlight);
    // 检查 copy="false" 属性，隐藏复制按钮
    const pre = findPre(header);
    if (pre && isCopyDisabled(header)) btn.style.display = "none";
  });

  /** 创建带复制按钮的文件名栏 */
  function createHeader() {
    const header = document.createElement("div");
    header.className = "book-codeblock-header";

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
    return { header, btn };
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
})();