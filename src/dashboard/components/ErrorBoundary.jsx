import React from 'react';

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
                <div className="dash-card dash-error-card">
                    <div className="dash-card-body" style={{ textAlign: 'center', padding: '32px 18px' }}>
                        <span className="material-symbols-outlined" style={{ fontSize: 36, color: 'var(--danger)', marginBottom: 8, display: 'block' }}>
                            error
                        </span>
                        <p style={{ color: 'var(--text-sec)', marginBottom: 16 }}>
                            이 섹션을 불러올 수 없습니다
                        </p>
                        <button className="dash-error-retry" onClick={this.handleRetry}>
                            다시 시도
                        </button>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}
