import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
export class PageBoundary extends Component<{ children: ReactNode; onHome: () => void }, { failed: boolean; revision: number }> {
  state = { failed: false, revision: 0 }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('Page failed', error, info.componentStack) }
  render() {
    if (this.state.failed) return <section className="page-failure panel" role="alert"><h1>这个页面暂时无法显示</h1><p>可以重试，或回到首页。已保存的设置仍然保留。</p><div><button className="primary" onClick={() => this.setState((s) => ({ failed: false, revision: s.revision + 1 }))}>重试页面</button><button onClick={this.props.onHome}>返回首页</button></div></section>
    return <Fragment key={this.state.revision}>{this.props.children}</Fragment>
  }
}
