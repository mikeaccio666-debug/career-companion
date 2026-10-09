import { Component, Suspense, lazy, useState, type ComponentType, type ReactNode } from 'react';
import { createFeatureLoader } from './feature-loader';
import './lazy-feature.css';
class FeatureBoundary extends Component<{ children: ReactNode; label: string; retry(): void }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    render() {
        if (this.state.failed) return <section className="career-surface feature-loading" aria-label={this.props.label + '暂时无法打开'}>
            <small>Career Companion · AI</small><h2>{this.props.label}暂时没打开</h2>
            <p role="alert">请检查网络后重试。重试只重新打开这块界面；不会刷新整个页面。</p>
            <button type="button" onClick={this.props.retry}>重试打开</button>
        </section>;
        return this.props.children;
    }
}
/** One local boundary per feature: loading a panel does not replace another
 * panel, the account provider, safety resources, or a draft already on screen. */
export function lazyFeature<P extends object>(load: () => Promise<{ default: ComponentType<P> }>, label: string) {
    const loadCode = createFeatureLoader(load);
    return function DeferredFeature(props: P) {
        const [attempt, setAttempt] = useState(() => ({ number: 0, View: lazy(loadCode) }));
        const View = attempt.View;
        return <FeatureBoundary key={attempt.number} label={label} retry={() => setAttempt(previous => ({ number: previous.number + 1, View: lazy(loadCode) }))}>
            <Suspense fallback={<section className="career-surface feature-loading" aria-label={label + '加载中'} aria-busy="true"><small>Career Companion · AI</small><p role="status">正在打开{label}…</p></section>}>
                <View {...props}/>
            </Suspense>
        </FeatureBoundary>;
    };
}
