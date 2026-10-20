import React, { useState, useEffect } from 'react';
import VisorGIS from './VisorGIS';
import ValidadorShapes from './ValidadorShapes';

// Paleta corporativa y tokens de diseño Aspire v4
export const ASPIRE_THEME = {
  blue: '#3C64A3',
  lightBlue: '#4D76B2',
  teal: '#008C96',
  cyan: '#0BB7D6',
  yellow: '#FED56D',
  black: '#1D1D1B',
  gray: '#333333',
  textSecondary: '#64748B',
  bg: '#F8FAFC',
  cardBg: '#FFFFFF',
  border: '#E2E8F0'
};

export default function MapViewer() {
  const [activeTab, setActiveTab] = useState('visor'); // 'visor' | 'validador'
  
  // Detección responsive para móvil y tablet
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1200
  );
  const isMobile = windowWidth < 768;

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div
      style={{
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        backgroundColor: ASPIRE_THEME.bg,
        height: '100dvh',
        width: '100%',
        maxWidth: '100vw',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        color: ASPIRE_THEME.black
      }}
    >
      {/* HEADER GLOBAL CON IDENTIDAD ASPIRE Y LOGO CENTRAL */}
      <header
        style={{
          backgroundColor: ASPIRE_THEME.cardBg,
          padding: isMobile ? '0.5rem 0.85rem' : '0.65rem 1.75rem',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)',
          borderBottom: `1px solid ${ASPIRE_THEME.border}`,
          zIndex: 100,
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          justifyContent: 'space-between',
          alignItems: isMobile ? 'stretch' : 'center',
          gap: isMobile ? '0.5rem' : '1.25rem',
          flexShrink: 0,
          width: '100%',
          boxSizing: 'border-box'
        }}
      >
        {/* LADO IZQUIERDO: LOGO ASPIRE + TÍTULO SNS */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', minWidth: 0, overflow: 'hidden' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0
            }}
          >
            <img
              src="main_logo.png"
              alt="Logo Aspire SNS"
              style={{
                height: isMobile ? '38px' : '100px',
                width: 'auto',
                maxWidth: isMobile ? '120px' : '460px',
                objectFit: 'contain',
                display: 'block'
              }}
              onError={(e) => {
                if (!e.currentTarget.dataset.retried) {
                  e.currentTarget.dataset.retried = 'true';
                  e.currentTarget.src = '/main_logo.png';
                }
              }}
            />
          </div>

          <div
            style={{
              width: '1px',
              height: isMobile ? '24px' : '32px',
              backgroundColor: ASPIRE_THEME.border,
              display: isMobile ? 'none' : 'block'
            }}
          />

          <div style={{ minWidth: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
    
              <span
                style={{
                  fontSize: '1.2rem',
                  fontWeight: '700',
                  backgroundColor: 'rgba(0, 140, 150, 0.12)',
                  color: ASPIRE_THEME.teal,
                  padding: '2px 6px',
                  borderRadius: '4px',
                  border: '1px solid rgba(0, 140, 150, 0.25)',
                  display: isMobile ? 'none' : 'inline-block'
                }}
              >
                GeoSNS
              </span>
            </div>
            <p
              style={{
                margin: '2px 0 0 0',
                fontSize: isMobile ? '0.66rem' : '0.72rem',
                color: ASPIRE_THEME.textSecondary,
                lineHeight: '1.2',
                whiteSpace: 'nowrap',
                textOverflow: 'ellipsis',
                overflow: 'hidden'
              }}
            >
            </p>
          </div>
        </div>

        {/* LADO DERECHO: SELECTOR DE PESTAÑAS ASPIRE PRO CON ICONOGRAFÍA VECTORIAL */}
        <nav
          role="tablist"
          aria-label="Vistas de la plataforma"
          style={{
            display: 'flex',
            alignItems: 'center',
            backgroundColor: '#F1F5F9',
            padding: '4px',
            borderRadius: '12px',
            border: `1px solid ${ASPIRE_THEME.border}`,
            gap: '4px',
            boxShadow: 'inset 0 1px 2px rgba(0, 0, 0, 0.04)',
            alignSelf: isMobile ? 'stretch' : 'auto',
            flexShrink: 0
          }}
        >
          {/* BOTÓN 1: VISOR Y FUSIONES */}
          <button
            role="tab"
            aria-selected={activeTab === 'visor'}
            onClick={() => setActiveTab('visor')}
            style={{
              flex: isMobile ? 1 : 'none',
              padding: isMobile ? '0.5rem 0.75rem' : '0.55rem 1.15rem',
              border: activeTab === 'visor' ? '1px solid rgba(255, 255, 255, 0.18)' : '1px solid transparent',
              borderRadius: '9px',
              cursor: 'pointer',
              fontSize: isMobile ? '0.76rem' : '0.82rem',
              fontWeight: activeTab === 'visor' ? '700' : '600',
              background: activeTab === 'visor'
                ? `linear-gradient(135deg, ${ASPIRE_THEME.blue} 0%, #294A7E 100%)`
                : 'transparent',
              color: activeTab === 'visor' ? '#FFFFFF' : '#475569',
              boxShadow: activeTab === 'visor'
                ? '0 3px 8px -1px rgba(60, 100, 163, 0.42), 0 1px 2px rgba(0, 0, 0, 0.08)'
                : 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
              outline: 'none',
              position: 'relative'
            }}
            onMouseEnter={(e) => {
              if (activeTab !== 'visor') {
                e.currentTarget.style.backgroundColor = '#FFFFFF';
                e.currentTarget.style.color = ASPIRE_THEME.blue;
              }
            }}
            onMouseLeave={(e) => {
              if (activeTab !== 'visor') {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = '#475569';
              }
            }}
          >
            {/* Icono Vectorial Mapa / Capas */}
            <svg
              width={isMobile ? "15" : "17"}
              height={isMobile ? "15" : "17"}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                flexShrink: 0,
                filter: activeTab === 'visor' ? 'drop-shadow(0 1px 1px rgba(0,0,0,0.2))' : 'none'
              }}
            >
              <polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6" />
              <line x1="8" y1="2" x2="8" y2="18" />
              <line x1="16" y1="6" x2="16" y2="22" />
            </svg>
            <span>Visor y Fusiones</span>
            {activeTab === 'visor' && (
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: ASPIRE_THEME.cyan,
                  boxShadow: `0 0 6px ${ASPIRE_THEME.cyan}`,
                  display: isMobile ? 'none' : 'inline-block'
                }}
              />
            )}
          </button>

          {/* BOTÓN 2: AUDITORÍA TOPOLÓGICA */}
          <button
            role="tab"
            aria-selected={activeTab === 'validador'}
            onClick={() => setActiveTab('validador')}
            style={{
              flex: isMobile ? 1 : 'none',
              padding: isMobile ? '0.5rem 0.75rem' : '0.55rem 1.15rem',
              border: activeTab === 'validador' ? '1px solid rgba(255, 255, 255, 0.2)' : '1px solid transparent',
              borderRadius: '9px',
              cursor: 'pointer',
              fontSize: isMobile ? '0.76rem' : '0.82rem',
              fontWeight: activeTab === 'validador' ? '700' : '600',
              background: activeTab === 'validador'
                ? `linear-gradient(135deg, ${ASPIRE_THEME.teal} 0%, #006067 100%)`
                : 'transparent',
              color: activeTab === 'validador' ? '#FFFFFF' : '#475569',
              boxShadow: activeTab === 'validador'
                ? '0 3px 8px -1px rgba(0, 140, 150, 0.42), 0 1px 2px rgba(0, 0, 0, 0.08)'
                : 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '8px',
              transition: 'all 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
              outline: 'none',
              position: 'relative'
            }}
            onMouseEnter={(e) => {
              if (activeTab !== 'validador') {
                e.currentTarget.style.backgroundColor = '#FFFFFF';
                e.currentTarget.style.color = ASPIRE_THEME.teal;
              }
            }}
            onMouseLeave={(e) => {
              if (activeTab !== 'validador') {
                e.currentTarget.style.backgroundColor = 'transparent';
                e.currentTarget.style.color = '#475569';
              }
            }}
          >
            {/* Icono Vectorial Escudo / Auditoría QA */}
            <svg
              width={isMobile ? "15" : "17"}
              height={isMobile ? "15" : "17"}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                flexShrink: 0,
                filter: activeTab === 'validador' ? 'drop-shadow(0 1px 1px rgba(0,0,0,0.2))' : 'none'
              }}
            >
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              <path d="m9 12 2 2 4-4" />
            </svg>
            <span>Auditoría Topológica</span>
            {activeTab === 'validador' && (
              <span
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  backgroundColor: ASPIRE_THEME.yellow,
                  boxShadow: `0 0 6px ${ASPIRE_THEME.yellow}`,
                  display: isMobile ? 'none' : 'inline-block'
                }}
              />
            )}
          </button>
        </nav>
      </header>

      {/* CONTENIDO PRINCIPAL: MONTAJE DEL COMPONENTE ACTIVO */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          minWidth: 0,
          width: '100%',
          maxWidth: '100%',
          boxSizing: 'border-box',
          position: 'relative',
          display: 'flex',
          overflow: 'hidden'
        }}
      >
        {activeTab === 'visor' ? <VisorGIS /> : <ValidadorShapes />}
      </main>

      {/* ESTILOS GLOBALES Y ANIMACIONES */}
      <style>{`
        *, *::before, *::after {
          box-sizing: border-box;
        }
        body, html {
          margin: 0;
          padding: 0;
          width: 100%;
          max-width: 100vw;
          overflow-x: hidden;
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .spinner {
          display: inline-block;
          animation: spin 1.2s linear infinite;
        }
        @keyframes spin {
          100% { transform: rotate(360deg); }
        }
        aside::-webkit-scrollbar, div::-webkit-scrollbar {
          width: 5px;
          height: 5px;
        }
        aside::-webkit-scrollbar-track, div::-webkit-scrollbar-track {
          background: transparent;
        }
        aside::-webkit-scrollbar-thumb, div::-webkit-scrollbar-thumb {
          background-color: #cbd5e1;
          border-radius: 10px;
        }
        aside::-webkit-scrollbar-thumb:hover, div::-webkit-scrollbar-thumb:hover {
          background-color: #94a3b8;
        }
      `}</style>
    </div>
  );
}