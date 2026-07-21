import React from 'react';
import { Icon, IconButton } from '@impact7/ui';
import { ICON_SVG } from '../icon-map.js';

export default class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    componentDidCatch(error, info) {
        console.error('[ErrorBoundary]', error, info);
    }

    handleRetry = () => {
        this.setState({ hasError: false });
    };

    render() {
        if (this.state.hasError) {
            return (
                <div role="alert" className="dash-card dash-error-card">
                    <div className="dash-card-body" style={{ textAlign: 'center', padding: '32px 18px' }}>
                        <Icon svg={ICON_SVG.error} size={36} style={{ color: 'var(--danger)', marginBottom: 8, display: 'block' }} aria-hidden="true" />
                        <p style={{ color: 'var(--text-sec)', marginBottom: 16 }}>
                            이 섹션을 불러올 수 없습니다
                        </p>
                        <IconButton svg={ICON_SVG.replay} label="다시 시도" onClick={this.handleRetry} />
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}
