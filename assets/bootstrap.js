/**
 * dsh-persona-studio —— 页面引导脚本
 *
 * 由宿主注入到 index.html（web 形态走 tapIndex，桌面壳走 webserver/index-inject）。
 * 只做两件事：注入样式、加载面板脚本；两者都带幂等保护，多次注入不会重复挂载。
 */
;(function () {
  'use strict'
  if (window.__DSH_PERSONA_FORGE__) return
  window.__DSH_PERSONA_FORGE__ = true

  // 路径前缀必须与宿主注册的路由一致。
  // 教训：改名时这里曾经漏掉（旧值 /dsh-persona 没有尾斜杠，批量替换没覆盖到），
  // 后果是面板脚本 404 —— 按钮永远不出现，而且不报任何错。
  var BASE = '/dsh-persona-studio'

  function addCss() {
    if (document.querySelector('link[data-dsh-persona-studio]')) return
    var link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = BASE + '/panel.css'
    link.setAttribute('data-dsh-persona-studio', '1')
    ;(document.head || document.documentElement).appendChild(link)
  }

  function addPanel() {
    if (document.querySelector('script[data-dsh-persona-studio]')) return
    var script = document.createElement('script')
    script.src = BASE + '/panel.js'
    script.defer = true
    script.setAttribute('data-dsh-persona-studio', '1')
    script.onerror = function () {
      try {
        console.warn('[dsh-persona-studio] 面板脚本加载失败（宿主插件可能未启用）')
      } catch (error) {
        /* 忽略 */
      }
    }
    ;(document.head || document.documentElement).appendChild(script)
  }

  function boot() {
    try {
      addCss()
      addPanel()
    } catch (error) {
      try {
        console.warn('[dsh-persona-studio] 引导失败：' + String((error && error.message) || error))
      } catch (inner) {
        /* 忽略 */
      }
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
