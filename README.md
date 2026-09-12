# Hugo-Book Starter

This is a template repository to bootstrap your documentation site with Hugo-Book theme. It contains minimal configured from the start hugo site.
1. To use this repository create a new repository from this template
2. Run `git clone --recurse-submodules --shallow-submodules https://github.com/{org/user}/{repository}`
3. Enter newly created directory `cd {repository}`
4. Run hugo `hugo server`

And you are ready to write docs!

# Configuration options
Please refer to [Hugo Documentation](https://gohugo.io/configuration/) and [Theme Source](https://github.com/alex-shpak/hugo-book/blob/main/exampleSite/hugo.yaml#L70)

# 代码块扩展（codeblock）

在代码围栏的 info string 后面用 `{...}` 声明属性，渲染时会挂到代码块的 `.highlight` 容器上：

````markdown
```js {filename="app.js", copy="false", collapse="true"}
console.log("hello");
console.log("world");
```
````

| 属性 | 作用 |
| --- | --- |
| `filename` | 代码块上方显示文件名栏（带文件名的代码块也会出现"复制"按钮） |
| `href` | 让文件名变成可点击链接，需与 `filename` 同时使用 |
| `copy="false"` | 隐藏"复制"按钮 |
| `collapse="true"` | 折叠模式：在"复制"按钮左侧多出一个"折叠/展开"按钮，默认主要显示第 1 行、第 2~3 行渐隐（表示下面还有内容）并显示"共 N 行"，点击可展开全部代码（`collapse="false"` 等同于不写该属性） |

未写 `collapse` 的代码块不会有折叠按钮，外观与原来完全一致。

写代码块语言时注意：Chroma 里 `ps` 是 **PostScript** 的别名，PowerShell 请写 `powershell`（`pwsh`、`ps1` 也可以），否则 `PS`、`D:`、`/Project` 之类会被拆成 PostScript 记号，颜色很乱。

实现位置：`assets/clipboard.js`（按钮注入、展开/折叠逻辑）、`assets/styles/custom.css`（`.book-codeblock-*` 样式）。
