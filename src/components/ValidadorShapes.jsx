import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { COMUNIDADES, normalizeFeatureProperties, runDuckDBFusion, runSpatialAudit, initDuckDB } from '../utils/geoUtils';

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
  border: '#E2E8F0',
  borderDark: '#CBD5E1',
  redBase: '#EF4444',
  blueUp: '#2563EB',
  purpleMod: '#7C3AED',
  orangeCode: '#EA580C',
  greenNew: '#16A34A',
  pinkRen: '#C026D3'
};

const CCAA_CODE_EQUIVALENCES = {
  'ES61': ['ES61', '01', '1'],
  'ES24': ['ES24', '02', '2'],
  'ES12': ['ES12', '03', '3'],
  'ES53': ['ES53', '04', '4'],
  'ES70': ['ES70', '05', '5'],
  'ES13': ['ES13', '06', '6'],
  'ES41': ['ES41', '07', '7'],
  'ES42': ['ES42', '08', '8'],
  'ES51': ['ES51', '09', '9'],
  'ES52': ['ES52', '10'],
  'ES43': ['ES43', '11'],
  'ES11': ['ES11', '12'],
  'ES30': ['ES30', '13'],
  'ES62': ['ES62', '14'],
  'ES22': ['ES22', '15'],
  'ES21': ['ES21', '16'],
  'ES23': ['ES23', '17'],
  'ES63': ['ES63', '18'],
  'ES64': ['ES64', '19']
};

const stringPool = new Map();
const intern = (str) => {
  if (!str) return '';
  const trimmed = (' ' + String(str).trim()).slice(1);
  let existing = stringPool.get(trimmed);
  if (!existing) {
    stringPool.set(trimmed, trimmed);
    existing = trimmed;
  }
  return existing;
};

const pruneCoordinates = (coords) => {
  if (!coords) return coords;
  if (typeof coords[0] === 'number') {
    return [
      Math.round(coords[0] * 100000) / 100000,
      Math.round(coords[1] * 100000) / 100000
    ];
  }
  return coords.map(pruneCoordinates);
};

export const extractPolygonalGeoJSON = (geom) => {
  if (!geom) return null;
  if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
    return geom;
  }
  if (geom.type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
    const polygonRings = [];
    for (const g of geom.geometries) {
      if (g.type === 'Polygon' && Array.isArray(g.coordinates)) {
        polygonRings.push(g.coordinates);
      } else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
        polygonRings.push(...g.coordinates);
      }
    }
    if (polygonRings.length === 1) {
      return { type: 'Polygon', coordinates: polygonRings[0] };
    } else if (polygonRings.length > 1) {
      return { type: 'MultiPolygon', coordinates: polygonRings };
    }
  }
  return null;
};

const computeBBox = (geometry) => {
  if (!geometry || !geometry.coordinates) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  const traverse = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    } else if (Array.isArray(c)) {
      c.forEach(traverse);
    }
  };

  traverse(geometry.coordinates);
  if (minX === Infinity) return null;
  return [[minX, minY], [maxX, maxY]];
};

// Campos obligatorios requeridos en la cabecera / propiedades del GeoJSON
const MANDATORY_GEOJSON_FIELDS = ['ccaa_cd', 'zbs_cd', 'zbs_st', 'area_cd', 'area_st'];

// Valida que TODOS los elementos de la colección incluyan las claves en su cabecera (sin exigir que tengan valor)
const validateAllGeoJsonFeatures = (features) => {
  if (!Array.isArray(features) || features.length === 0) {
    return { valid: false, error: 'El archivo GeoJSON está vacío o no tiene una lista de elementos (features).' };
  }

  const missingReport = [];
  const invalidGeomIndices = [];

  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    if (!f || typeof f !== 'object') {
      missingReport.push(`Elemento #${i + 1}: objeto no válido.`);
      continue;
    }

    // Comprobación de geometría presente
    if (!f.geometry || !f.geometry.type || !f.geometry.coordinates) {
      invalidGeomIndices.push(i + 1);
    }

    // Comprobación de cabecera de propiedades en este elemento
    const props = f.properties;
    if (!props || typeof props !== 'object') {
      missingReport.push(`Elemento #${i + 1}: sin propiedades (properties es nulo o no es un objeto).`);
      continue;
    }

    // Comprobación estricta de existencia de las claves de la cabecera (independientemente del valor que contengan)
    const missingInThisFeature = MANDATORY_GEOJSON_FIELDS.filter(
      field => !(field in props)
    );

    if (missingInThisFeature.length > 0) {
      const zbsIdentifier = props.zbs_cd || props.ZBS_CD || props.codatzbs || `Elemento #${i + 1}`;
      missingReport.push(`${zbsIdentifier} (falta la clave: ${missingInThisFeature.join(', ')})`);
    }

    // Si acumulamos suficientes errores para informar al usuario, cortamos para no penalizar rendimiento
    if (missingReport.length > 15) break;
  }

  if (invalidGeomIndices.length > 0) {
    return {
      valid: false,
      error: `Existen elementos sin geometría válida en los índices: [${invalidGeomIndices.slice(0, 10).join(', ')}${invalidGeomIndices.length > 10 ? '...' : ''}].`
    };
  }

  if (missingReport.length > 0) {
    return {
      valid: false,
      error: `No todos los elementos contienen las claves requeridas (${MANDATORY_GEOJSON_FIELDS.join(', ')}). Incidencias en: ${missingReport.slice(0, 8).join('; ')}${missingReport.length > 8 ? '... y más elementos.' : '.'}`
    };
  }

  return { valid: true };
};

const PRESET_JUSTIFICATIONS = [
  'Ajuste perimetral catastral',
  'Desdoblamiento por crecimiento demográfico',
  'Fusión autorizada según decreto autonómico',
  'Corrección toponímica oficial de denominación',
  'Modificación de adscripción a nueva Área de Salud',
  'Reordenación de mapa sanitario municipal'
];

export default function ValidadorShapes() {
  const [targetCCAA, setTargetCCAA] = useState('ES30');
  const [baseYear, setBaseYear] = useState('2024');
  const [grouping, setGrouping] = useState('zbs'); // 'zbs' | 'area'

  const [loading, setLoading] = useState(false);
  const [processingStatus, setProcessingStatus] = useState('');
  const [parquetFileName, setParquetFileName] = useState('spain_zbs_historico.parquet');
  const [duckdbReady, setDuckdbReady] = useState(false);
  const duckDbConnRef = useRef(null);

  const [report, setReport] = useState(null);
  const [spatialAudit, setSpatialAudit] = useState({ matches: [], modified: [] });
  const [fileName, setFileName] = useState('');
  const [fileStats, setFileStats] = useState(null);
  const [comments, setComments] = useState({});
  const [notification, setNotification] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  // Filtros de navegación de incidencias
  const [issueSearchFilter, setIssueSearchFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'pending' | 'resolved'
  const [selectedIssueFocus, setSelectedIssueFocus] = useState(null);

  // Visibilidad y opacidades de capas en el mapa
  const [showBaseLayer, setShowBaseLayer] = useState(true);
  const [showUpLayer, setShowUpLayer] = useState(true);
  const [baseOpacity, setBaseOpacity] = useState(0.24);
  const [upOpacity, setUpOpacity] = useState(0.42);

  // Responsive state
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1200
  );
  const isMobile = windowWidth < 1024;
  const [mobileTab, setMobileTab] = useState('audit'); // 'audit' | 'map' | 'report'

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapLibreReady, setMapLibreReady] = useState(false);

  // Referencias estables de memoria para evitar retener JSONs gigantes en el heap
  const baseFeaturesRef = useRef([]);
  const upFeaturesRef = useRef([]);
  const baseMapRef = useRef(new Map());
  const upMapRef = useRef(new Map());

  // Almacenes de Áreas fusionadas en memoria para auditoría de Área
  const baseAreaFeaturesRef = useRef([]);
  const upAreaFeaturesRef = useRef([]);

  // Acordeones abiertos
  const [openSections, setOpenSections] = useState({
    espacial: true,
    modificadas: true,
    nuevas: true,
    eliminadas: false,
    movidas: false,
    renombradas: false,
    cambioCodigo: false
  });

  const toggleSection = (sec) => setOpenSections(prev => ({ ...prev, [sec]: !prev[sec] }));
  const handleCommentChange = (key, text) => setComments(prev => ({ ...prev, [key]: text }));

  // Sincronización de capas en MapLibre tanto en modo ZBS como en modo Áreas fusionadas
  const syncMapSources = useCallback(async () => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;

    const baseSrc = map.getSource('audit-base-source');
    const upSrc = map.getSource('audit-up-source');
    if (!baseSrc || !upSrc) return;

    if (grouping === 'zbs') {
      baseSrc.setData({ type: 'FeatureCollection', features: baseFeaturesRef.current });
      upSrc.setData({ type: 'FeatureCollection', features: upFeaturesRef.current });

      const featsToFit = upFeaturesRef.current.length > 0 ? upFeaturesRef.current : baseFeaturesRef.current;
      if (featsToFit.length > 0 && featsToFit[0].geometry) {
        const bbox = computeBBox(featsToFit[0].geometry);
        if (bbox) {
          map.fitBounds(bbox, { maxZoom: 9.5, duration: 600 });
        }
      }
    } else {
      setLoading(true);
      setProcessingStatus('Fusionando Áreas de Salud para visualización en mapa...');
      try {
        let mBase = baseAreaFeaturesRef.current;
        if (!mBase || mBase.length === 0) {
          mBase = await runDuckDBFusion(baseFeaturesRef.current, 'val_base');
          baseAreaFeaturesRef.current = mBase;
        }
        baseSrc.setData({ type: 'FeatureCollection', features: mBase });

        if (upFeaturesRef.current.length > 0) {
          let mUp = upAreaFeaturesRef.current;
          if (!mUp || mUp.length === 0) {
            mUp = await runDuckDBFusion(upFeaturesRef.current, 'val_up');
            upAreaFeaturesRef.current = mUp;
          }
          upSrc.setData({ type: 'FeatureCollection', features: mUp });
        } else {
          upSrc.setData({ type: 'FeatureCollection', features: [] });
        }

        const featsToFit = upAreaFeaturesRef.current.length > 0 ? upAreaFeaturesRef.current : mBase;
        if (featsToFit.length > 0 && featsToFit[0].geometry) {
          const bbox = computeBBox(featsToFit[0].geometry);
          if (bbox) {
            map.fitBounds(bbox, { maxZoom: 9.5, duration: 600 });
          }
        }
      } catch (err) {
        console.error('Error al sincronizar capas de áreas:', err);
      } finally {
        setLoading(false);
        setProcessingStatus('');
      }
    }
  }, [grouping, mapLoaded]);

  useEffect(() => {
    let isSubscribed = true;

    const init = async () => {
      try {
        setLoading(true);
        setProcessingStatus('Iniciando DuckDB-Wasm Spatial para auditoría...');
        const db = await initDuckDB();
        const conn = await db.connect();
        duckDbConnRef.current = conn;


        const baseUrl = import.meta.env?.BASE_URL || '/';
        const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

        const candidateUrls = [
          `${normalizedBase}data/spain_zbs_historico.parquet`,
        ];

        for (const url of candidateUrls) {
          try {
            const res = await fetch(url);
            if (res.ok) {
              const ct = res.headers.get('content-type') || '';
              if (ct.includes('text/html')) continue;
              const buf = await res.arrayBuffer();
              if (buf.byteLength > 1000) {
                await db.registerFileBuffer('spain_zbs_historico.parquet', new Uint8Array(buf));
                break;
              }
            }
          } catch (_) {}
        }

        if (!isSubscribed) return;
        setDuckdbReady(true);
      } catch (err) {
        console.error('Error inicializando DuckDB en ValidadorShapes:', err);
      } finally {
        if (isSubscribed) setLoading(false);
      }
    };

    init();
    return () => { isSubscribed = false; };
  }, []);

  const handleGroupingChange = (newGrouping) => {
    if (newGrouping === grouping) return;
    if (newGrouping === 'area') {
      setLoading(true);
      setProcessingStatus('Iniciando fusión topológica de Áreas de Salud con DuckDB...');
    } else {
      setLoading(true);
      setProcessingStatus('Cambiando a visualización y auditoría de ZBS...');
    }
    setGrouping(newGrouping);
  };

  useEffect(() => {
    if (window.maplibregl) {
      setMapLibreReady(true);
      return;
    }

    if (!document.getElementById('maplibre-css')) {
      const link = document.createElement('link');
      link.id = 'maplibre-css';
      link.rel = 'stylesheet';
      link.href = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.css';
      document.head.appendChild(link);
    }

    const script = document.createElement('script');
    script.src = 'https://unpkg.com/maplibre-gl@3.6.2/dist/maplibre-gl.js';
    script.async = true;
    script.onload = () => setMapLibreReady(true);
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    if (!mapLibreReady || !mapContainer.current || mapRef.current) return;

    try {
      const map = new window.maplibregl.Map({
        container: mapContainer.current,
        style: 'https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json',
        center: [-4.2, 36.2],
        zoom: isMobile ? 3.9 : 4.85
      });

      map.addControl(new window.maplibregl.NavigationControl(), 'top-right');

      map.on('load', () => {
        // Capa Base Oficial 2024 (Rojo con contorno discontinuo)
        map.addSource('audit-base-source', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          promoteId: 'feature_id'
        });

        map.addLayer({
          id: 'audit-base-fill',
          type: 'fill',
          source: 'audit-base-source',
          paint: {
            'fill-color': ASPIRE_THEME.redBase,
            'fill-opacity': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              0.65,
              baseOpacity
            ]
          }
        });

        map.addLayer({
          id: 'audit-base-line',
          type: 'line',
          source: 'audit-base-source',
          paint: {
            'line-color': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              '#DC2626',
              '#991B1B'
            ],
            'line-width': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              3.4,
              1.8
            ],
            'line-dasharray': [3, 2]
          }
        });

        // Capa Subida Propuesta (Azul Aspire sólido)
        map.addSource('audit-up-source', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] },
          promoteId: 'feature_id'
        });

        map.addLayer({
          id: 'audit-up-fill',
          type: 'fill',
          source: 'audit-up-source',
          paint: {
            'fill-color': ASPIRE_THEME.blueUp,
            'fill-opacity': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              0.75,
              upOpacity
            ]
          }
        });

        map.addLayer({
          id: 'audit-up-line',
          type: 'line',
          source: 'audit-up-source',
          paint: {
            'line-color': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              '#0BB7D6',
              '#1E3A8A'
            ],
            'line-width': [
              'case',
              ['boolean', ['feature-state', 'hover'], false],
              3.8,
              2.0
            ]
          }
        });

        // Capa de foco / resaltado de incidencia activa
        map.addSource('audit-focus-source', {
          type: 'geojson',
          data: { type: 'FeatureCollection', features: [] }
        });

        map.addLayer({
          id: 'audit-focus-line',
          type: 'line',
          source: 'audit-focus-source',
          paint: {
            'line-color': ASPIRE_THEME.yellow,
            'line-width': 3.8
          }
        });

        // Popup interactivo de hover y sincronización de resaltado dual
        const hoverPopup = new window.maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 12
        });

        let currentHoveredBaseId = null;
        let currentHoveredUpId = null;

        const clearDualHover = () => {
          map.getCanvas().style.cursor = '';
          hoverPopup.remove();

          if (currentHoveredBaseId) {
            try {
              map.setFeatureState({ source: 'audit-base-source', id: currentHoveredBaseId }, { hover: false });
            } catch (_) {}
            currentHoveredBaseId = null;
          }
          if (currentHoveredUpId) {
            try {
              map.setFeatureState({ source: 'audit-up-source', id: currentHoveredUpId }, { hover: false });
            } catch (_) {}
            currentHoveredUpId = null;
          }
        };

        const handleDualHoverMove = (e) => {
          if (!e.features || !e.features.length) return;
          map.getCanvas().style.cursor = 'pointer';

          const featProps = e.features[0].properties;
          const code = featProps.codatzbs;
          const areaNorm = featProps.nombre_area_normalizado;

          // Buscar geometrías coincidentes en ambos almacenes
          const baseFeat = baseMapRef.current.get(code);
          const upFeat = upMapRef.current.get(code);

          const targetBaseId = baseFeat ? baseFeat.id : (featProps.feature_id?.startsWith('BASE_') ? featProps.feature_id : null);
          const targetUpId = upFeat ? upFeat.id : (featProps.feature_id?.startsWith('UP_') ? featProps.feature_id : null);

          // Si cambió la zona enfocada, actualizar el estado de hover simultáneo
          if (targetBaseId !== currentHoveredBaseId || targetUpId !== currentHoveredUpId) {
            if (currentHoveredBaseId) {
              try { map.setFeatureState({ source: 'audit-base-source', id: currentHoveredBaseId }, { hover: false }); } catch (_) {}
            }
            if (currentHoveredUpId) {
              try { map.setFeatureState({ source: 'audit-up-source', id: currentHoveredUpId }, { hover: false }); } catch (_) {}
            }

            currentHoveredBaseId = targetBaseId;
            currentHoveredUpId = targetUpId;

            if (currentHoveredBaseId) {
              try { map.setFeatureState({ source: 'audit-base-source', id: currentHoveredBaseId }, { hover: true }); } catch (_) {}
            }
            if (currentHoveredUpId) {
              try { map.setFeatureState({ source: 'audit-up-source', id: currentHoveredUpId }, { hover: true }); } catch (_) {}
            }
          }

          // Construcción del tooltip comparativo Base 2024 vs Propuesta
          const baseProps = baseFeat?.properties;
          const upProps = upFeat?.properties || (!featProps.feature_id?.startsWith('BASE_') ? featProps : null);
          const title = featProps.is_area ? `Área: ${areaNorm}` : `ZBS: ${featProps.n_zbs || code}`;

          let comparisonHtml = `
            <div style="font-family:system-ui,sans-serif;padding:4px 6px;line-height:1.35;min-width:210px;max-width:280px;">
              <div style="color:${ASPIRE_THEME.black};font-weight:700;font-size:12px;margin-bottom:5px;border-bottom:1px solid #E2E8F0;padding-bottom:3px;">
                ${title} <span style="font-size:10px;font-weight:normal;color:${ASPIRE_THEME.textSecondary};">(${code || '-'})</span>
              </div>
          `;

          if (baseProps) {
            comparisonHtml += `
              <div style="display:flex;align-items:flex-start;gap:5px;margin-bottom:3px;">
                <span style="display:inline-block;font-size:9px;font-weight:700;color:#991B1B;background:rgba(239,68,68,0.14);padding:1px 5px;border-radius:3px;flex-shrink:0;">
                  ● Base 2024
                </span>
                <span style="font-size:10px;color:#1E293B;">
                  ${baseProps.n_zbs || baseProps.nombre_area_normalizado} • <em>${baseProps.area || '-'}</em>
                </span>
              </div>
            `;
          } else {
            comparisonHtml += `
              <div style="font-size:9.5px;color:#DC2626;font-style:italic;margin-bottom:3px;">
                ● No existía en Base 2024 (Alta nueva)
              </div>
            `;
          }

          if (upProps) {
            comparisonHtml += `
              <div style="display:flex;align-items:flex-start;gap:5px;margin-top:2px;">
                <span style="display:inline-block;font-size:9px;font-weight:700;color:#1D4ED8;background:rgba(37,99,235,0.14);padding:1px 5px;border-radius:3px;flex-shrink:0;">
                  ▲ Subida
                </span>
                <span style="font-size:10px;color:#1E293B;">
                  ${upProps.n_zbs || upProps.nombre_area_normalizado} • <em>${upProps.area || '-'}</em>
                </span>
              </div>
            `;
          } else {
            comparisonHtml += `
              <div style="font-size:9.5px;color:#DC2626;font-style:italic;margin-top:2px;">
                ▲ Eliminada en propuesta subida
              </div>
            `;
          }

          comparisonHtml += `
              <div style="font-size:9px;color:${ASPIRE_THEME.textSecondary};margin-top:4px;border-top:1px dashed #E2E8F0;padding-top:2px;text-align:right;">
                Resaltado sincronizado en ambas capas
              </div>
            </div>
          `;

          hoverPopup
            .setLngLat(e.lngLat)
            .setHTML(comparisonHtml)
            .addTo(map);
        };

        map.on('mousemove', 'audit-up-fill', handleDualHoverMove);
        map.on('mousemove', 'audit-base-fill', handleDualHoverMove);

        map.on('mouseleave', 'audit-up-fill', clearDualHover);
        map.on('mouseleave', 'audit-base-fill', clearDualHover);

        mapRef.current = map;
        setMapLoaded(true);
      });
    } catch (err) {
      console.error('Error al inicializar MapLibre en ValidadorShapes:', err);
    }

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [mapLibreReady, isMobile]);

  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;

    if (map.getLayer('audit-base-fill')) {
      map.setLayoutProperty('audit-base-fill', 'visibility', showBaseLayer ? 'visible' : 'none');
      map.setLayoutProperty('audit-base-line', 'visibility', showBaseLayer ? 'visible' : 'none');
      map.setPaintProperty('audit-base-fill', 'fill-opacity', [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        0.65,
        baseOpacity
      ]);
    }

    if (map.getLayer('audit-up-fill')) {
      map.setLayoutProperty('audit-up-fill', 'visibility', showUpLayer ? 'visible' : 'none');
      map.setLayoutProperty('audit-up-line', 'visibility', showUpLayer ? 'visible' : 'none');
      map.setPaintProperty('audit-up-fill', 'fill-opacity', [
        'case',
        ['boolean', ['feature-state', 'hover'], false],
        0.75,
        upOpacity
      ]);
    }
  }, [showBaseLayer, showUpLayer, baseOpacity, upOpacity, mapLoaded]);

  useEffect(() => {
    if (!duckdbReady || !duckDbConnRef.current) return;

    let isSubscribed = true;
    baseFeaturesRef.current = [];
    baseMapRef.current.clear();
    setReport(null);
    setSpatialAudit({ matches: [], modified: [] });
    setSelectedIssueFocus(null);
    setLoading(true);
    setProcessingStatus(`Extrayendo base oficial de ${targetCCAA} (${baseYear}) desde Parquet...`);

    const loadOfficialDataFromParquet = async () => {
      try {
        const conn = duckDbConnRef.current;
        const targetYearInt = parseInt(baseYear, 10);

        const equivs = CCAA_CODE_EQUIVALENCES[targetCCAA] || [targetCCAA];
        const ccaaFilterList = equivs.map(c => `'${c}'`).join(',');

        const sqlBaselineQuery = `
          WITH raw_filtered AS (
            SELECT 
              CAST(OGC_FID AS VARCHAR) as OGC_FID,
              TRIM(CAST(ccaa_cd AS VARCHAR)) as ccaa_cd,
              CAST(id_zbs AS VARCHAR) as id_zbs,
              TRIM(CAST(zbs_cd AS VARCHAR)) as zbs_cd,
              TRIM(CAST(zbs_st AS VARCHAR)) as zbs_st,
              CAST(area_id AS VARCHAR) as area_id,
              CAST(area_cd AS VARCHAR) as area_cd,
              TRIM(CAST(area_st AS VARCHAR)) as area_st,
              CAST(valid_from AS VARCHAR) as valid_from,
              CAST(valid_to AS VARCHAR) as valid_to,
              CAST("version" AS VARCHAR) as "version",
              ST_AsGeoJSON(
                ST_CollectionExtract(
                  ST_MakeValid(geom), 
                  3
                )
              ) as geom_json,
              TRY_CAST(REGEXP_EXTRACT(CAST(valid_from AS VARCHAR), '([12][0-9]{3})') AS INT) as from_yr,
              TRY_CAST(REGEXP_EXTRACT(CAST(valid_to AS VARCHAR), '([12][0-9]{3})') AS INT) as to_yr
            FROM read_parquet('${parquetFileName}')
            WHERE (
              TRIM(UPPER(CAST(ccaa_cd AS VARCHAR))) IN (${ccaaFilterList})
              OR TRIM(CAST(ccaa_cd AS VARCHAR)) IN (${ccaaFilterList})
            )
          )
          SELECT *
          FROM raw_filtered
          WHERE (
            valid_from IS NULL 
            OR valid_from IN ('', 'None', 'null', 'NULL')
            OR from_yr IS NULL 
            OR from_yr <= ${targetYearInt}
          )
          AND (
            valid_to IS NULL 
            OR valid_to IN ('', 'None', 'null', 'NULL')
            OR to_yr IS NULL 
            OR to_yr > ${targetYearInt}
            OR (to_yr = ${targetYearInt} AND valid_to LIKE '%12-31%')
          )
        `;

        const queryRes = await conn.query(sqlBaselineQuery);
        if (!isSubscribed) return;

        const rows = queryRes.toArray();
        const collected = [];
        const baseMap = baseMapRef.current;
        baseMap.clear();

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          let parsedGeom = null;
          if (row.geom_json) {
            try {
              parsedGeom = JSON.parse(row.geom_json);
            } catch (_) {}
          }

          const cleanGeom = extractPolygonalGeoJSON(parsedGeom);
          if (!cleanGeom) continue;

          const ccaaCd = intern(String(row.ccaa_cd || targetCCAA).trim());
          const zbsCd = intern(String(row.zbs_cd || '').replace(/\.0+$/, '').trim());
          const zbsSt = intern(String(row.zbs_st || zbsCd).trim());
          const areaSt = intern(String(row.area_st || 'Área no asignada').trim());
          const fId = intern(`BASE_${targetCCAA}_${zbsCd || i}`);

          const cleanProps = {
            feature_id: fId,
            OGC_FID: row.OGC_FID,
            id_zbs: row.id_zbs,
            ccaa_cd: ccaaCd,
            zbs_cd: zbsCd,
            zbs_st: zbsSt,
            area_cd: intern(String(row.area_cd || '').trim()),
            area_st: areaSt,
            // Alias retrocompatibles para visualización e inspección
            codatzbs: zbsCd,
            n_zbs: zbsSt,
            area: areaSt,
            area_id: row.area_id,
            valid_from: row.valid_from,
            valid_to: row.valid_to,
            version: row.version,
            ccaa_id: intern(targetCCAA),
            nombre_area_normalizado: intern(areaSt.toUpperCase()),
            nombre_zbs_normalizado: intern(`${zbsCd}_${zbsSt.toUpperCase()}`),
            is_area: false
          };

          const featObj = {
            type: 'Feature',
            id: fId,
            geometry: cleanGeom,
            properties: cleanProps
          };

          collected.push(featObj);
          baseMap.set(zbsCd, featObj);
        }

        baseFeaturesRef.current = collected;
        syncMapSources();

        if (upFeaturesRef.current.length > 0) {
          ejecutarAuditoria();
        }
      } catch (err) {
        console.error('Error al consultar base oficial desde DuckDB Parquet:', err);
        if (isSubscribed) {
          setNotification({ type: 'warning', text: `Error consultando la base de ${targetCCAA} en el fichero Parquet.` });
        }
      } finally {
        if (isSubscribed) setLoading(false);
      }
    };

    loadOfficialDataFromParquet();
    return () => {
      isSubscribed = false;
    };
  }, [duckdbReady, targetCCAA, baseYear, parquetFileName, syncMapSources]);

  const processUploadedGeoJSON = (file) => {
    if (!file) return;

    upFeaturesRef.current = [];
    upMapRef.current.clear();
    setReport(null);
    setSpatialAudit({ matches: [], modified: [] });
    setFileName(file.name);
    setSelectedIssueFocus(null);
    setNotification(null);
    setLoading(true);
    setProcessingStatus(`Analizando ${file.name}...`);

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target.result);
        if (!json.features || !Array.isArray(json.features)) {
          setNotification({ type: 'error', text: 'El archivo no contiene una colección válida de geometrías (FeatureCollection).' });
          setLoading(false);
          return;
        }

        if (json.features.length === 0) {
          setNotification({ type: 'error', text: 'El archivo GeoJSON está vacío (0 features).' });
          setLoading(false);
          return;
        }

        // Validación estricta en TODOS los elementos del GeoJSON
        const validation = validateAllGeoJsonFeatures(json.features);

        if (!validation.valid) {
          setNotification({
            type: 'error',
            text: `Validación fallida: ${validation.error} Se exige que todos los registros incluyan obligatoriamente: ccaa_cd, zbs_cd, zbs_st, area_cd, area_st junto con la geometría.`
          });
          setLoading(false);
          return;
        }

        const collected = [];
        const upMap = upMapRef.current;
        upMap.clear();

        for (let i = 0; i < json.features.length; i++) {
          const f = json.features[i];
          const rawProps = f?.properties || {};

          // Extracción canónica de los 5 campos requeridos permitiendo valores vacíos o nulos
          const ccaaCd = intern(String(rawProps.ccaa_cd ?? targetCCAA).trim());
          const zbsCd = intern(String(rawProps.zbs_cd ?? '').replace(/\.0+$/, '').trim());
          const zbsSt = intern(String(rawProps.zbs_st ?? (zbsCd || `ZBS_${i + 1}`)).trim());
          const areaCd = intern(String(rawProps.area_cd ?? '').trim());
          const areaSt = intern(String(rawProps.area_st ?? 'Área no asignada').trim());

          const fId = intern(`UP_${ccaaCd || targetCCAA}_${zbsCd || i}`);

          const cleanProps = {
            feature_id: fId,
            // Campos canónicos obligatorios
            ccaa_cd: ccaaCd,
            zbs_cd: zbsCd,
            zbs_st: zbsSt,
            area_cd: areaCd,
            area_st: areaSt,
            // Compatibilidad para filtros y leyendas
            codatzbs: zbsCd,
            n_zbs: zbsSt,
            area: areaSt,
            ccaa_id: ccaaCd,
            nombre_area_normalizado: intern(areaSt.toUpperCase()),
            nombre_zbs_normalizado: intern(`${zbsCd}_${zbsSt.toUpperCase()}`),
            is_area: false
          };

          const featObj = {
            type: 'Feature',
            id: fId,
            geometry: f.geometry ? {
              type: f.geometry.type,
              coordinates: pruneCoordinates(f.geometry.coordinates)
            } : f.geometry,
            properties: cleanProps
          };

          collected.push(featObj);
          upMap.set(cleanProps.zbs_cd || `TEMP_${i}`, featObj);
          json.features[i] = null;
        }

        upFeaturesRef.current = collected;
        setFileStats({
          name: file.name,
          sizeMb: (file.size / (1024 * 1024)).toFixed(2),
          featuresCount: collected.length
        });

        syncMapSources();
        ejecutarAuditoria();
      } catch (err) {
        setNotification({ type: 'error', text: 'Error al parsear el archivo GeoJSON. Asegúrate de que sea un JSON válido.' });
        setLoading(false);
      }
    };
    reader.readAsText(file);
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (file) processUploadedGeoJSON(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) processUploadedGeoJSON(file);
  };

  // Función pura de auditoría reutilizable para ZBS y Áreas
  const computeAuditForDataset = useCallback(async (baseFeats, upFeats, isAreaMode) => {
    if (!baseFeats.length || !upFeats.length) {
      return {
        report: null,
        spatial: { matches: [], modified: [] }
      };
    }

    const baseMap = new Map();
    const upMap = new Map();

    baseFeats.forEach((f, idx) => {
      const p = f.properties || {};
      const key = isAreaMode
        ? String(p.area_st || p.area || p.nombre_area_normalizado || `AREA_${idx}`).trim().toUpperCase()
        : String(p.codatzbs || p.zbs_cd || `ZBS_${idx}`).trim();
      baseMap.set(key, f);
    });

    upFeats.forEach((f, idx) => {
      const p = f.properties || {};
      const key = isAreaMode
        ? String(p.area_st || p.area || p.nombre_area_normalizado || `AREA_${idx}`).trim().toUpperCase()
        : String(p.codatzbs || p.zbs_cd || `ZBS_${idx}`).trim();
      upMap.set(key, f);
    });

    const eliminadas = [];
    const nuevas = [];
    const movidas = [];
    const renombradas = [];
    const cambioCodigo = [];
    const featsNuevasTemp = upFeats.filter((f) => {
      const p = f.properties || {};
      const key = isAreaMode
        ? String(p.area_st || p.area || p.nombre_area_normalizado || '').trim().toUpperCase()
        : String(p.codatzbs || p.zbs_cd || '').trim();
      return !baseMap.has(key);
    });

    baseMap.forEach((baseF, key) => {
      const bProps = baseF.properties || {};

      if (!upMap.has(key)) {
        if (!isAreaMode) {
          const matchIdx = featsNuevasTemp.findIndex(
            (newF) => (newF.properties?.n_zbs || newF.properties?.zbs_st) === (bProps.n_zbs || bProps.zbs_st)
          );
          if (matchIdx !== -1) {
            cambioCodigo.push({
              baseProps: bProps,
              upProps: featsNuevasTemp[matchIdx].properties,
              baseGeom: baseF.geometry,
              upGeom: featsNuevasTemp[matchIdx].geometry
            });
            featsNuevasTemp.splice(matchIdx, 1);
          } else {
            eliminadas.push({ ...bProps, geometry: baseF.geometry });
          }
        } else {
          const bCd = (bProps.area_cd || '').trim();
          const matchIdx = bCd
            ? featsNuevasTemp.findIndex((newF) => (newF.properties?.area_cd || '').trim() === bCd)
            : -1;

          if (matchIdx !== -1) {
            renombradas.push({
              code: bCd,
              baseProps: bProps,
              upProps: featsNuevasTemp[matchIdx].properties,
              baseGeom: baseF.geometry,
              upGeom: featsNuevasTemp[matchIdx].geometry
            });
            featsNuevasTemp.splice(matchIdx, 1);
          } else {
            eliminadas.push({ ...bProps, geometry: baseF.geometry });
          }
        }
      } else {
        const upF = upMap.get(key);
        const uProps = upF.properties || {};

        if (!isAreaMode) {
          if ((uProps.area || uProps.area_st) !== (bProps.area || bProps.area_st)) {
            movidas.push({
              code: key,
              baseProps: bProps,
              upProps: uProps,
              baseGeom: baseF.geometry,
              upGeom: upF.geometry
            });
          }
          if ((uProps.n_zbs || uProps.zbs_st) !== (bProps.n_zbs || bProps.zbs_st)) {
            renombradas.push({
              code: key,
              baseProps: bProps,
              upProps: uProps,
              baseGeom: baseF.geometry,
              upGeom: upF.geometry
            });
          }
        } else {
          if (bProps.area_cd && uProps.area_cd && bProps.area_cd !== uProps.area_cd) {
            cambioCodigo.push({
              baseProps: bProps,
              upProps: uProps,
              baseGeom: baseF.geometry,
              upGeom: upF.geometry
            });
          }
          if (bProps.total_zbs && uProps.total_zbs && bProps.total_zbs !== uProps.total_zbs) {
            movidas.push({
              code: key,
              baseProps: bProps,
              upProps: uProps,
              baseGeom: baseF.geometry,
              upGeom: upF.geometry
            });
          }
        }
      }
    });

    featsNuevasTemp.forEach((f) => nuevas.push({ ...f.properties, geometry: f.geometry }));

    const reportRes = {
      counts: { baseZbs: baseMap.size, upZbs: upMap.size },
      eliminadas,
      nuevas,
      movidas,
      renombradas,
      cambioCodigo,
      isAreaMode
    };

    let spatialRes = { matches: [], modified: [] };
    try {
      const rawSpatial = await runSpatialAudit(baseFeats, upFeats);
      const matchesFiltrados = rawSpatial.matches.filter(
        (m) =>
          !cambioCodigo.some(
            (cc) =>
              (cc.baseProps?.codatzbs || cc.baseProps?.area_cd || cc.baseProps?.area_st) === m.elimCod &&
              (cc.upProps?.codatzbs || cc.upProps?.area_cd || cc.upProps?.area_st) === m.newCod
          )
      );
      spatialRes = { matches: matchesFiltrados, modified: rawSpatial.modified };
    } catch (e) {
      console.warn('Error en auditoría espacial:', e);
    }

    return { report: reportRes, spatial: spatialRes };
  }, []);

  const ejecutarAuditoria = useCallback(async () => {
    const isAreaMode = grouping === 'area';
    let baseFeatsToAudit = [];
    let upFeatsToAudit = [];

    setLoading(true);
    setProcessingStatus(
      isAreaMode
        ? 'Fusionando y auditando discrepancias a nivel de Área de Salud...'
        : 'Auditando discrepancias a nivel de ZBS...'
    );

    try {
      if (isAreaMode) {
        if (!baseFeaturesRef.current.length || !upFeaturesRef.current.length) {
          setReport(null);
          setLoading(false);
          return;
        }

        let mBase = baseAreaFeaturesRef.current;
        let mUp = upAreaFeaturesRef.current;

        if (!mBase.length || !mUp.length) {
          [mBase, mUp] = await Promise.all([
            runDuckDBFusion(baseFeaturesRef.current, 'val_base_audit'),
            runDuckDBFusion(upFeaturesRef.current, 'val_up_audit')
          ]);
          baseAreaFeaturesRef.current = mBase;
          upAreaFeaturesRef.current = mUp;
        }

        baseFeatsToAudit = mBase;
        upFeatsToAudit = mUp;
      } else {
        baseFeatsToAudit = baseFeaturesRef.current;
        upFeatsToAudit = upFeaturesRef.current;
      }

      const { report: rep, spatial: spat } = await computeAuditForDataset(baseFeatsToAudit, upFeatsToAudit, isAreaMode);
      setReport(rep);
      setSpatialAudit(spat);
    } catch (err) {
      console.error('Error durante la auditoría:', err);
    } finally {
      setLoading(false);
      setProcessingStatus('');
    }
  }, [grouping, computeAuditForDataset]);

  useEffect(() => {
    if (baseFeaturesRef.current.length > 0 && upFeaturesRef.current.length > 0) {
      ejecutarAuditoria();
    }
  }, [grouping, ejecutarAuditoria]);

  useEffect(() => {
    syncMapSources();
  }, [grouping, syncMapSources]);

  const handleFocusIssue = (issue, typeKey, e) => {
    if (e) e.stopPropagation();
    setSelectedIssueFocus({ issue, typeKey });

    const geom = issue.geometry || issue.upGeom || issue.baseGeom;
    if (!geom || !mapRef.current) return;

    const bbox = computeBBox(geom);
    if (bbox) {
      mapRef.current.fitBounds(bbox, { padding: 90, maxZoom: 13.5, duration: 750 });
    }

    // Actualizar capa de foco amarillo
    const focusSrc = mapRef.current.getSource('audit-focus-source');
    if (focusSrc) {
      focusSrc.setData({
        type: 'FeatureCollection',
        features: [{ type: 'Feature', geometry: geom, properties: {} }]
      });
    }

    if (isMobile) setMobileTab('map');
  };

  const qaKpis = useMemo(() => {
    if (!report) return null;
    const totalIssues =
      spatialAudit.matches.length +
      spatialAudit.modified.length +
      report.cambioCodigo.length +
      report.renombradas.length +
      report.nuevas.length +
      report.eliminadas.length +
      report.movidas.length;

    let justifiedCount = 0;
    Object.keys(comments).forEach(k => {
      if (comments[k]?.trim()) justifiedCount++;
    });

    const completionRate = totalIssues === 0 ? 100 : Math.min(100, Math.round((justifiedCount / totalIssues) * 100));

    return {
      totalIssues,
      justifiedCount,
      completionRate,
      baseCount: report.counts.baseZbs,
      upCount: report.counts.upZbs,
      diffCount: report.counts.upZbs - report.counts.baseZbs,
      isAreaMode: Boolean(report.isAreaMode)
    };
  }, [report, spatialAudit, comments]);

  // Exportación consolidada y única: ZBS + Áreas de Salud en un solo informe
  const exportarInforme = async (format = 'txt') => {
    if (!baseFeaturesRef.current.length || !upFeaturesRef.current.length) return;

    setLoading(true);
    setProcessingStatus('Generando informe consolidado único (ZBS + Áreas de Salud)...');

    try {
      // 1. Obtener auditoría ZBS
      const auditZbs = await computeAuditForDataset(baseFeaturesRef.current, upFeaturesRef.current, false);

      // 2. Obtener auditoría Áreas de Salud (fusionando si no existen en memoria)
      let mBase = baseAreaFeaturesRef.current;
      let mUp = upAreaFeaturesRef.current;
      if (!mBase.length || !mUp.length) {
        [mBase, mUp] = await Promise.all([
          runDuckDBFusion(baseFeaturesRef.current, 'rep_base_area'),
          runDuckDBFusion(upFeaturesRef.current, 'rep_up_area')
        ]);
        baseAreaFeaturesRef.current = mBase;
        upAreaFeaturesRef.current = mUp;
      }
      const auditArea = await computeAuditForDataset(mBase, mUp, true);

      const ccaaNombre = COMUNIDADES.find(c => c.id === targetCCAA)?.nombre || targetCCAA;
      const dateStr = new Date().toLocaleDateString('es-ES', { year: 'numeric', month: 'long', day: 'numeric' });

      // Cálculo de métricas globales
      const repZ = auditZbs.report;
      const spatZ = auditZbs.spatial;
      const repA = auditArea.report;
      const spatA = auditArea.spatial;

      const totalIssuesZ = (repZ?.nuevas.length || 0) + (repZ?.eliminadas.length || 0) +
        (repZ?.movidas.length || 0) + (repZ?.renombradas.length || 0) + (repZ?.cambioCodigo.length || 0) +
        (spatZ?.matches.length || 0) + (spatZ?.modified.length || 0);

      const totalIssuesA = (repA?.nuevas.length || 0) + (repA?.eliminadas.length || 0) +
        (repA?.movidas.length || 0) + (repA?.renombradas.length || 0) + (repA?.cambioCodigo.length || 0) +
        (spatA?.matches.length || 0) + (spatA?.modified.length || 0);

      const totalGlobalIssues = totalIssuesZ + totalIssuesA;

      let content = '';

      if (format === 'md') {
        content = `# INFORME CONSOLIDADO DE AUDITORÍA CARTOGRÁFICA SNS\n\n`;
        content += `**Comunidad Autónoma:** ${ccaaNombre} (${targetCCAA})  \n`;
        content += `**Fecha de Emisión:** ${dateStr}  \n`;
        content += `**Archivo Analizado:** \`${fileName || 'cartografia_subida.geojson'}\`  \n`;
        content += `**Año Base de Cotejo:** ${baseYear}  \n`;
        content += `**Total Incidencias Detectadas:** ${totalGlobalIssues} (${totalIssuesZ} en ZBS, ${totalIssuesA} en Áreas de Salud)  \n\n`;

        content += `---\n\n`;
        content += `## RESUMEN EJECUTIVO Y BALANCE ESTRUCTURAL\n\n`;
        content += `| Nivel Territorial | Base Oficial ${baseYear} | Propuesta Subida | Variación Neta |\n`;
        content += `| :--- | :---: | :---: | :---: |\n`;
        content += `| **Zonas Básicas de Salud (ZBS)** | ${repZ?.counts.baseZbs || 0} | ${repZ?.counts.upZbs || 0} | ${(repZ?.counts.upZbs || 0) - (repZ?.counts.baseZbs || 0) >= 0 ? `+${(repZ?.counts.upZbs || 0) - (repZ?.counts.baseZbs || 0)}` : (repZ?.counts.upZbs || 0) - (repZ?.counts.baseZbs || 0)} |\n`;
        content += `| **Áreas de Salud (Fusionadas)** | ${repA?.counts.baseZbs || 0} | ${repA?.counts.upZbs || 0} | ${(repA?.counts.upZbs || 0) - (repA?.counts.baseZbs || 0) >= 0 ? `+${(repA?.counts.upZbs || 0) - (repA?.counts.baseZbs || 0)}` : (repA?.counts.upZbs || 0) - (repA?.counts.baseZbs || 0)} |\n\n`;

        // SECCIÓN 1: ZBS
        content += `\n# SECCIÓN 1: AUDITORÍA A NIVEL DE ZONAS BÁSICAS DE SALUD (ZBS)\n\n`;
        const writeMdBlock = (title, items, typeKey, renderRow) => {
          if (!items || !items.length) return;
          content += `### ${title} (${items.length})\n\n`;
          items.forEach((item, idx) => {
            const code = item.code || item.codatzbs || item.area_cd || item.area_st || item.elimCod || item.cod || item.upProps?.codatzbs || item.upProps?.area_cd;
            const justification = comments[`${typeKey}-${code}`] || comments[`${code}`] || '*Sin justificación registrada.*';
            content += `${idx + 1}. ${renderRow(item)}\n   - **Justificación Técnica:** ${justification}\n\n`;
          });
        };

        writeMdBlock('1.1. Cruces y Solapes Espaciales (Posibles Fusiones / Escisiones)', spatZ?.matches, 'match', m => `**${m.elimNom}** (\`${m.elimCod}\`) ➔ **${m.newNom}** (\`${m.newCod}\`)`);
        writeMdBlock('1.2. Fronteras y Perímetros Modificados', spatZ?.modified, 'mod', z => `ZBS **${z.nom}** (Código: \`${z.cod}\`)`);
        writeMdBlock('1.3. Cambios de Código Administrativo', repZ?.cambioCodigo, 'cod', z => `\`${z.baseProps.codatzbs}\` ➔ \`${z.upProps.codatzbs}\` (*${z.baseProps.n_zbs}*)`);
        writeMdBlock('1.4. Cambios de Denominación Toponímica', repZ?.renombradas, 'ren', z => `Código \`${z.code}\`: *${z.baseProps.n_zbs}* ➔ **${z.upProps.n_zbs}**`);
        writeMdBlock('1.5. Zonas Básicas de Salud Creadas (Altas Nuevas)', repZ?.nuevas, 'new', z => `**${z.n_zbs}** (Código: \`${z.codatzbs}\` • Área de Salud: *${z.area || z.area_st}*)`);
        writeMdBlock('1.6. Zonas Básicas de Salud Suprimidas (Bajas)', repZ?.eliminadas, 'elim', z => `~~${z.n_zbs}~~ (Código: \`${z.codatzbs}\` • Área de Salud: *${z.area || z.area_st}*)`);
        writeMdBlock('1.7. Cambios de Adscripción a Área de Salud', repZ?.movidas, 'mov', z => `\`${z.code}\` (*${z.upProps?.n_zbs}*): De *${z.baseProps?.area || z.baseProps?.area_st}* ➔ **${z.upProps?.area || z.upProps?.area_st}**`);

        if (totalIssuesZ === 0) {
          content += `*No se detectaron discrepancias a nivel de Zonas Básicas de Salud.*\n\n`;
        }

        content += `---\n\n`;

        // SECCIÓN 2: ÁREAS DE SALUD
        content += `# SECCIÓN 2: AUDITORÍA A NIVEL DE ÁREAS DE SALUD (FUSIONADAS)\n\n`;
        writeMdBlock('2.1. Cruces y Solapes Espaciales de Área', spatA?.matches, 'match', m => `Área **${m.elimNom}** ➔ **${m.newNom}**`);
        writeMdBlock('2.2. Perímetros de Área Alterados', spatA?.modified, 'mod', z => `Área **${z.nom}** (Código: \`${z.cod}\`)`);
        writeMdBlock('2.3. Cambios de Código de Área', repA?.cambioCodigo, 'cod', z => `Área **${z.baseProps.area_st}**: \`${z.baseProps.area_cd}\` ➔ \`${z.upProps.area_cd}\``);
        writeMdBlock('2.4. Renombramiento de Áreas', repA?.renombradas, 'ren', z => `Código de Área \`${z.code}\`: *${z.baseProps.area_st}* ➔ **${z.upProps.area_st}**`);
        writeMdBlock('2.5. Nuevas Áreas de Salud Creadas', repA?.nuevas, 'new', z => `**${z.area_st || z.nombre_area_normalizado}** (${z.total_zbs || 1} ZBS integradas)`);
        writeMdBlock('2.6. Áreas de Salud Suprimidas', repA?.eliminadas, 'elim', z => `~~${z.area_st || z.nombre_area_normalizado}~~`);
        writeMdBlock('2.7. Reestructuración en el Recuento de ZBS por Área', repA?.movidas, 'mov', z => `Área **${z.code}**: Pasa de ${z.baseProps?.total_zbs || 0} ZBS ➔ A ${z.upProps?.total_zbs || 0} ZBS`);

        if (totalIssuesA === 0) {
          content += `*No se detectaron discrepancias a nivel de Áreas de Salud.*\n\n`;
        }
      } else {
        content = `======================================================================\n`;
        content += `  INFORME CONSOLIDADO DE AUDITORÍA CARTOGRÁFICA SNS (ZBS + ÁREAS)\n`;
        content += `  Comunidad Autónoma: ${ccaaNombre} (${targetCCAA}) | Fecha: ${dateStr}\n`;
        content += `  Archivo evaluado: ${fileName || 'cartografia_subida.geojson'}\n`;
        content += `  Año oficial base: ${baseYear}\n`;
        content += `  Total Incidencias: ${totalGlobalIssues} (ZBS: ${totalIssuesZ} | Áreas: ${totalIssuesA})\n`;
        content += `======================================================================\n\n`;

        content += `[ BALANCE ESTRUCTURAL GLOBAL ]\n`;
        content += `* Zonas Básicas de Salud (ZBS): Oficiales ${baseYear}: ${repZ?.counts.baseZbs || 0} | Subidas: ${repZ?.counts.upZbs || 0} | Variación: ${(repZ?.counts.upZbs || 0) - (repZ?.counts.baseZbs || 0)}\n`;
        content += `* Áreas de Salud (Fusionadas): Oficiales ${baseYear}: ${repA?.counts.baseZbs || 0} | Subidas: ${repA?.counts.upZbs || 0} | Variación: ${(repA?.counts.upZbs || 0) - (repA?.counts.baseZbs || 0)}\n\n`;

        const writeTxtBlock = (sectionTitle, items, typeKey, renderRow) => {
          if (!items || !items.length) return;
          content += `\n>>> ${sectionTitle.toUpperCase()} (${items.length})\n`;
          content += `----------------------------------------------------------------------\n`;
          items.forEach(item => {
            const code = item.code || item.codatzbs || item.area_cd || item.area_st || item.elimCod || item.cod || item.upProps?.codatzbs || item.upProps?.area_cd;
            const justification = comments[`${typeKey}-${code}`] || comments[`${code}`] || 'Sin justificación registrada.';
            content += `${renderRow(item)}\n    >> Justificación: ${justification}\n\n`;
          });
        };

        content += `\n######################################################################\n`;
        content += `  SECCIÓN 1: DISCREPANCIAS A NIVEL DE ZONAS BÁSICAS DE SALUD (ZBS)\n`;
        content += `######################################################################\n`;

        writeTxtBlock('1.1. Cruces Espaciales (Fusiones / Escisiones)', spatZ?.matches, 'match', m => `-> Cruce: [${m.elimCod}] ${m.elimNom} ➔ [${m.newCod}] ${m.newNom}`);
        writeTxtBlock('1.2. Fronteras y Perímetros Alterados', spatZ?.modified, 'mod', z => `-> Perímetro alterado: [${z.cod}] ${z.nom}`);
        writeTxtBlock('1.3. Cambios de Código Administrativo', repZ?.cambioCodigo, 'cod', z => `-> Código: [${z.baseProps.codatzbs}] ➔ [${z.upProps.codatzbs}] (${z.baseProps.n_zbs})`);
        writeTxtBlock('1.4. Cambios de Denominación Toponímica', repZ?.renombradas, 'ren', z => `-> Renombre [${z.code}]: "${z.baseProps.n_zbs}" ➔ "${z.upProps.n_zbs}"`);
        writeTxtBlock('1.5. ZBS Creadas (Altas Nuevas)', repZ?.nuevas, 'new', z => `-> Alta ZBS: [${z.codatzbs}] ${z.n_zbs} (Área: ${z.area || z.area_st})`);
        writeTxtBlock('1.6. ZBS Suprimidas (Bajas)', repZ?.eliminadas, 'elim', z => `-> Baja ZBS: [${z.codatzbs}] ${z.n_zbs} (Área: ${z.area || z.area_st})`);
        writeTxtBlock('1.7. Cambios de Área de Salud', repZ?.movidas, 'mov', z => `-> Traslado [${z.code}]: De "${z.baseProps?.area || z.baseProps?.area_st}" ➔ A "${z.upProps?.area || z.upProps?.area_st}"`);

        content += `\n######################################################################\n`;
        content += `  SECCIÓN 2: DISCREPANCIAS A NIVEL DE ÁREAS DE SALUD (FUSIONADAS)\n`;
        content += `######################################################################\n`;

        writeTxtBlock('2.1. Cruces Espaciales de Área', spatA?.matches, 'match', m => `-> Cruce Área: [${m.elimCod}] ${m.elimNom} ➔ [${m.newCod}] ${m.newNom}`);
        writeTxtBlock('2.2. Perímetros de Área Alterados', spatA?.modified, 'mod', z => `-> Perímetro de Área alterado: [${z.cod}] ${z.nom}`);
        writeTxtBlock('2.3. Cambios de Código de Área', repA?.cambioCodigo, 'cod', z => `-> Código de Área: [${z.baseProps.area_cd}] ➔ [${z.upProps.area_cd}] (${z.baseProps.area_st})`);
        writeTxtBlock('2.4. Renombramiento de Áreas', repA?.renombradas, 'ren', z => `-> Renombre de Área [${z.code}]: "${z.baseProps.area_st}" ➔ "${z.upProps.area_st}"`);
        writeTxtBlock('2.5. Nuevas Áreas Creadas', repA?.nuevas, 'new', z => `-> Alta Área: ${z.area_st || z.nombre_area_normalizado} (${z.total_zbs || 1} ZBS integradas)`);
        writeTxtBlock('2.6. Áreas Suprimidas', repA?.eliminadas, 'elim', z => `-> Baja Área: ${z.area_st || z.nombre_area_normalizado}`);
        writeTxtBlock('2.7. Variación en Recuento de ZBS por Área', repA?.movidas, 'mov', z => `-> Reestructuración [${z.code}]: Pasa de ${z.baseProps?.total_zbs || 0} a ${z.upProps?.total_zbs || 0} ZBS`);
      }

      const mime = format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8';
      const blob = new Blob([content], { type: mime });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `Auditoria_Consolidada_ZBS_y_Areas_${ccaaNombre.replace(/\s+/g, '_')}_${targetCCAA}.${format}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      console.error('Error al exportar informe consolidado:', err);
      setNotification({ type: 'error', text: 'Error generando el informe consolidado único.' });
    } finally {
      setLoading(false);
      setProcessingStatus('');
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        width: '100%',
        maxWidth: '100vw',
        height: '100%',
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        boxSizing: 'border-box',
        overflow: 'hidden',
        backgroundColor: ASPIRE_THEME.bg,
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
      }}
    >
      {/* Navegación móvil (Pestañas superiores) */}
      {isMobile && (
        <nav
          role="tablist"
          style={{
            display: 'flex',
            width: '100%',
            background: '#ffffff',
            padding: '4px',
            borderBottom: `1px solid ${ASPIRE_THEME.border}`,
            flexShrink: 0,
            gap: '4px'
          }}
        >
          <button
            role="tab"
            aria-selected={mobileTab === 'audit'}
            onClick={() => setMobileTab('audit')}
            style={{
              flex: 1,
              padding: '0.5rem',
              borderRadius: '8px',
              border: 'none',
              backgroundColor: mobileTab === 'audit' ? ASPIRE_THEME.blue : 'transparent',
              color: mobileTab === 'audit' ? '#ffffff' : ASPIRE_THEME.gray,
              fontWeight: '700',
              fontSize: '0.74rem',
              cursor: 'pointer'
            }}
          >
            📋 Incidencias ({qaKpis?.totalIssues || 0})
          </button>
          <button
            role="tab"
            aria-selected={mobileTab === 'map'}
            onClick={() => setMobileTab('map')}
            style={{
              flex: 1,
              padding: '0.5rem',
              borderRadius: '8px',
              border: 'none',
              backgroundColor: mobileTab === 'map' ? ASPIRE_THEME.blue : 'transparent',
              color: mobileTab === 'map' ? '#ffffff' : ASPIRE_THEME.gray,
              fontWeight: '700',
              fontSize: '0.74rem',
              cursor: 'pointer'
            }}
          >
            🗺️ Mapa Dual
          </button>
        </nav>
      )}

      {/* PANEL LATERAL: WORKFLOW DE AUDITORÍA Y DISCREPANCIAS */}
      <aside
        style={{
          display: isMobile && mobileTab !== 'audit' ? 'none' : 'flex',
          flexDirection: 'column',
          width: isMobile ? '100%' : 'clamp(380px, 35vw, 540px)',
          flexShrink: 0,
          height: '100%',
          minHeight: 0,
          minWidth: 0,
          borderRight: `1px solid ${ASPIRE_THEME.border}`,
          backgroundColor: '#ffffff',
          overflowY: 'auto',
          overflowX: 'hidden'
        }}
      >
        {/* BLOQUE 1: HEADER DE CONFIGURACIÓN & DROPZONE */}
        <div style={{ padding: '1rem', borderBottom: `1px solid ${ASPIRE_THEME.border}`, display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '100%', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '4px' }}>
            <div>
              <h2 style={{ margin: 0, fontSize: '1.02rem', fontWeight: '700', color: ASPIRE_THEME.black }}>
                Auditoría Topológica SNS
              </h2>
              <span style={{ fontSize: '0.7rem', color: ASPIRE_THEME.textSecondary }}>
                Cotejo automatizado frente a la base oficial 2024
              </span>
            </div>
            <span
              style={{
                fontSize: '0.66rem',
                backgroundColor: 'rgba(0, 140, 150, 0.12)',
                color: ASPIRE_THEME.teal,
                padding: '2px 8px',
                borderRadius: '5px',
                fontWeight: '700'
              }}
            >
              Control QA
            </span>
          </div>

          {/* Selectores de CCAA y Agrupación */}
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 0.9fr) minmax(0, 1fr)', gap: '6px', width: '100%', boxSizing: 'border-box' }}>
            <div style={{ minWidth: 0 }}>
              <label style={{ display: 'block', fontSize: '0.68rem', fontWeight: '700', color: ASPIRE_THEME.gray, marginBottom: '2px' }}>
                Comunidad Oficial Base
              </label>
              <select
                value={targetCCAA}
                onChange={(e) => setTargetCCAA(e.target.value)}
                disabled={loading}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '0.4rem 0.5rem',
                  borderRadius: '6px',
                  border: `1px solid ${ASPIRE_THEME.border}`,
                  fontSize: '0.75rem',
                  backgroundColor: '#ffffff',
                  outline: 'none'
                }}
              >
                {COMUNIDADES.map(c => <option key={c.id} value={c.id}>{c.nombre}</option>)}
              </select>
            </div>

            <div style={{ minWidth: 0 }}>
              <label style={{ display: 'block', fontSize: '0.68rem', fontWeight: '700', color: ASPIRE_THEME.gray, marginBottom: '2px' }}>
                Año Base Parquet
              </label>
              <select
                value={baseYear}
                onChange={(e) => setBaseYear(e.target.value)}
                disabled={loading}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '0.4rem 0.5rem',
                  borderRadius: '6px',
                  border: `1px solid ${ASPIRE_THEME.border}`,
                  fontSize: '0.75rem',
                  backgroundColor: '#ffffff',
                  outline: 'none'
                }}
              >
                {['2022', '2023', '2024', '2025', '2026'].map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>

            <div style={{ minWidth: 0 }}>
              <label style={{ display: 'block', fontSize: '0.68rem', fontWeight: '700', color: ASPIRE_THEME.gray, marginBottom: '2px' }}>
                Nivel Territorial
              </label>
              <select
                value={grouping}
                onChange={(e) => handleGroupingChange(e.target.value)}
                disabled={loading}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '0.4rem 0.5rem',
                  borderRadius: '6px',
                  border: `1px solid ${ASPIRE_THEME.blue}`,
                  fontSize: '0.75rem',
                  backgroundColor: 'rgba(60, 100, 163, 0.08)',
                  color: ASPIRE_THEME.blue,
                  fontWeight: '700',
                  outline: 'none',
                  cursor: loading ? 'not-allowed' : 'pointer'
                }}
              >
                <option value="zbs">ZBS (Interna)</option>
                <option value="area">Áreas (Fusionadas)</option>
              </select>
            </div>
          </div>

          {/* Dropzone de carga de GeoJSON */}
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            style={{
              border: `2px dashed ${isDragging ? ASPIRE_THEME.blue : ASPIRE_THEME.borderDark}`,
              borderRadius: '8px',
              padding: '0.75rem',
              backgroundColor: isDragging ? 'rgba(60, 100, 163, 0.05)' : '#f8fafc',
              textAlign: 'center',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              width: '100%',
              boxSizing: 'border-box'
            }}
            onClick={() => document.getElementById('geo-upload-input')?.click()}
          >
            <input
              id="geo-upload-input"
              type="file"
              accept=".geojson,application/json"
              onChange={handleFileUpload}
              style={{ display: 'none' }}
            />
            <div style={{ fontSize: '1.25rem', marginBottom: '2px' }}>📂</div>
            <span style={{ fontSize: '0.74rem', fontWeight: '700', color: ASPIRE_THEME.blue, display: 'block' }}>
              {fileName ? fileName : 'Arrastra aquí tu GeoJSON modificado o pulsa para subir'}
            </span>
            <span style={{ fontSize: '0.66rem', color: ASPIRE_THEME.textSecondary }}>
              {fileStats
                ? `${fileStats.featuresCount} zonas detectadas (${fileStats.sizeMb} MB) • Cabecera verificada`
                : 'Cabecera requerida: ccaa_cd, zbs_cd, zbs_st, area_cd, area_st + geom'}
            </span>
          </div>

          {/* Notification banner */}
          {notification && (
            <div
              style={{
                backgroundColor: notification.type === 'error' ? '#FEF2F2' : '#EFF6FF',
                border: `1px solid ${notification.type === 'error' ? '#FCA5A5' : '#BFDBFE'}`,
                color: notification.type === 'error' ? '#B91C1C' : ASPIRE_THEME.blue,
                padding: '0.45rem 0.75rem',
                borderRadius: '6px',
                fontSize: '0.72rem',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between'
              }}
            >
              <span>{notification.text}</span>
              <button
                onClick={() => setNotification(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}
              >
                ×
              </button>
            </div>
          )}

          {/* KPI Dashboard Card */}
          {qaKpis && (
            <div
              style={{
                backgroundColor: '#f8fafc',
                border: `1px solid ${ASPIRE_THEME.border}`,
                borderRadius: '8px',
                padding: '0.65rem 0.85rem'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '0.7rem', fontWeight: '700', color: ASPIRE_THEME.black }}>
                  Progreso de Justificación
                </span>
                <span style={{ fontSize: '0.7rem', fontWeight: '700', color: ASPIRE_THEME.teal }}>
                  {qaKpis.justifiedCount} de {qaKpis.totalIssues} ({qaKpis.completionRate}%)
                </span>
              </div>
              <div style={{ width: '100%', height: '6px', backgroundColor: '#e2e8f0', borderRadius: '4px', overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${qaKpis.completionRate}%`,
                    height: '100%',
                    backgroundColor: qaKpis.completionRate === 100 ? ASPIRE_THEME.teal : ASPIRE_THEME.blue,
                    transition: 'width 0.3s ease'
                  }}
                />
              </div>

              {/* Botones de Exportar informe */}
              <div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
                <button
                  onClick={() => exportarInforme('txt')}
                  style={{
                    flex: 1,
                    backgroundColor: ASPIRE_THEME.black,
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '5px',
                    padding: '0.38rem',
                    fontSize: '0.68rem',
                    fontWeight: '700',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '4px'
                  }}
                >
                  <span>📥</span> Informe TXT
                </button>
                <button
                  onClick={() => exportarInforme('md')}
                  style={{
                    flex: 1,
                    backgroundColor: ASPIRE_THEME.teal,
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '5px',
                    padding: '0.38rem',
                    fontSize: '0.68rem',
                    fontWeight: '700',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '4px'
                  }}
                >
                  <span>📋</span> Markdown
                </button>
              </div>
            </div>
          )}
        </div>

        {/* BLOQUE 2: LISTA CATEGORIZADA DE INCIDENCIAS CON FILTRO */}
        <div style={{ padding: '0.85rem 1rem', flex: 1, minHeight: 0 }}>
          {!report ? (
            <div style={{ textAlign: 'center', color: ASPIRE_THEME.textSecondary, padding: '2rem 1rem', fontSize: '0.78rem' }}>
              <strong>Esperando archivo para auditar</strong>
              <p style={{ margin: '4px 0 0 0', fontSize: '0.72rem' }}>
                Carga un GeoJSON modificado para comparar sus polígonos frente a la base oficial {grouping === 'area' ? 'a nivel de Áreas de Salud' : 'a nivel de ZBS'}.
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {/* Filtro de búsqueda rápida dentro de incidencias */}
              <input
                type="text"
                placeholder={grouping === 'area' ? "Filtrar por nombre o código de Área de Salud..." : "Filtrar por nombre o código de ZBS..."}
                value={issueSearchFilter}
                onChange={(e) => setIssueSearchFilter(e.target.value)}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '0.4rem 0.65rem',
                  borderRadius: '6px',
                  border: `1px solid ${ASPIRE_THEME.border}`,
                  fontSize: '0.72rem',
                  outline: 'none'
                }}
              />

              {/* 1. Cruces Espaciales (Fusiones / Escisiones) */}
              {spatialAudit.matches.length > 0 && (
                <div style={{ border: '1px solid #BFDBFE', borderRadius: '8px', overflow: 'hidden' }}>
                  <button
                    onClick={() => toggleSection('espacial')}
                    style={{
                      width: '100%',
                      padding: '0.55rem 0.75rem',
                      background: '#EFF6FF',
                      border: 'none',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      cursor: 'pointer',
                      color: '#1D4ED8',
                      fontWeight: '700',
                      fontSize: '0.76rem'
                    }}
                  >
                    <span>🤖 Cruces Espaciales ({spatialAudit.matches.length})</span>
                    <span>{openSections.espacial ? '▲' : '▼'}</span>
                  </button>
                  {openSections.espacial && (
                    <div style={{ padding: '0.65rem', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {spatialAudit.matches.map((m, idx) => {
                        const key = `match-${m.elimCod}`;
                        return (
                          <div
                            key={idx}
                            onClick={(e) => handleFocusIssue(m, 'match', e)}
                            style={{
                              padding: '0.55rem',
                              background: '#F8FAFC',
                              border: `1px solid ${selectedIssueFocus?.issue === m ? ASPIRE_THEME.blue : '#E2E8F0'}`,
                              borderRadius: '6px',
                              cursor: 'pointer'
                            }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.74rem', marginBottom: '4px' }}>
                              <span style={{ textDecoration: 'line-through', color: '#E11D48', fontWeight: '700' }}>{m.elimNom}</span>
                              <span>➔</span>
                              <span style={{ color: '#16A34A', fontWeight: '700' }}>{m.newNom}</span>
                            </div>
                            <textarea
                              placeholder="Escribe la justificación técnica..."
                              value={comments[key] || ''}
                              onChange={(e) => handleCommentChange(key, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              style={{ width: '100%', minHeight: '40px', padding: '0.35rem', border: `1px solid ${ASPIRE_THEME.border}`, borderRadius: '4px', fontSize: '0.7rem', boxSizing: 'border-box' }}
                            />
                            {/* Plantillas de texto rápido */}
                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
                              {PRESET_JUSTIFICATIONS.slice(0, 3).map((pj) => (
                                <button
                                  key={pj}
                                  onClick={(e) => { e.stopPropagation(); handleCommentChange(key, pj); }}
                                  style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', color: ASPIRE_THEME.blue, fontSize: '0.62rem', padding: '1px 5px', borderRadius: '3px', cursor: 'pointer' }}
                                >
                                  + {pj}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* 2. Geometrías / Fronteras Modificadas */}
              {spatialAudit.modified.length > 0 && (
                <div style={{ border: '1px solid #DDD6FE', borderRadius: '8px', overflow: 'hidden' }}>
                  <button
                    onClick={() => toggleSection('modificadas')}
                    style={{
                      width: '100%',
                      padding: '0.55rem 0.75rem',
                      background: '#F5F3FF',
                      border: 'none',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      cursor: 'pointer',
                      color: ASPIRE_THEME.purpleMod,
                      fontWeight: '700',
                      fontSize: '0.76rem'
                    }}
                  >
                    <span>📐 Fronteras Alteradas ({spatialAudit.modified.length})</span>
                    <span>{openSections.modificadas ? '▲' : '▼'}</span>
                  </button>
                  {openSections.modificadas && (
                    <div style={{ padding: '0.65rem', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {spatialAudit.modified.map((z, idx) => {
                        const key = `mod-${z.cod}`;
                        return (
                          <div
                            key={idx}
                            onClick={(e) => handleFocusIssue(z, 'mod', e)}
                            style={{
                              padding: '0.55rem',
                              background: '#F8FAFC',
                              border: `1px solid ${selectedIssueFocus?.issue === z ? ASPIRE_THEME.purpleMod : '#E2E8F0'}`,
                              borderRadius: '6px',
                              cursor: 'pointer'
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                              <span style={{ fontWeight: '700', fontSize: '0.74rem', color: ASPIRE_THEME.purpleMod }}>{z.nom}</span>
                              <span style={{ fontSize: '0.64rem', background: '#EDE9FE', padding: '1px 5px', borderRadius: '3px' }}>Cód: {z.cod}</span>
                            </div>
                            <textarea
                              placeholder="Justificación del ajuste perimetral..."
                              value={comments[key] || ''}
                              onChange={(e) => handleCommentChange(key, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              style={{ width: '100%', minHeight: '40px', padding: '0.35rem', border: `1px solid ${ASPIRE_THEME.border}`, borderRadius: '4px', fontSize: '0.7rem', boxSizing: 'border-box' }}
                            />
                            <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginTop: '4px' }}>
                              {PRESET_JUSTIFICATIONS.slice(0, 2).map((pj) => (
                                <button
                                  key={pj}
                                  onClick={(e) => { e.stopPropagation(); handleCommentChange(key, pj); }}
                                  style={{ background: '#F5F3FF', border: '1px solid #DDD6FE', color: ASPIRE_THEME.purpleMod, fontSize: '0.62rem', padding: '1px 5px', borderRadius: '3px', cursor: 'pointer' }}
                                >
                                  + {pj}
                                </button>
                              ))}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* 3. Zonas / Áreas Nuevas Creadas */}
              {report.nuevas.length > 0 && (
                <div style={{ border: '1px solid #BBF7D0', borderRadius: '8px', overflow: 'hidden' }}>
                  <button
                    onClick={() => toggleSection('nuevas')}
                    style={{
                      width: '100%',
                      padding: '0.55rem 0.75rem',
                      background: '#F0FDF4',
                      border: 'none',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      cursor: 'pointer',
                      color: ASPIRE_THEME.greenNew,
                      fontWeight: '700',
                      fontSize: '0.76rem'
                    }}
                  >
                    <span>➕ {grouping === 'area' ? 'Áreas Nuevas' : 'Zonas Nuevas'} ({report.nuevas.length})</span>
                    <span>{openSections.nuevas ? '▲' : '▼'}</span>
                  </button>
                  {openSections.nuevas && (
                    <div style={{ padding: '0.65rem', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {report.nuevas.map((z, idx) => {
                        const key = `new-${z.codatzbs || z.area_cd || z.area_st}`;
                        const title = grouping === 'area' ? (z.area_st || z.nombre_area_normalizado) : z.n_zbs;
                        const sub = grouping === 'area' ? `${z.total_zbs || 1} ZBS integradas` : `Cód: ${z.codatzbs}`;

                        return (
                          <div
                            key={idx}
                            onClick={(e) => handleFocusIssue(z, 'new', e)}
                            style={{
                              padding: '0.55rem',
                              background: '#F8FAFC',
                              border: `1px solid ${selectedIssueFocus?.issue === z ? ASPIRE_THEME.greenNew : '#E2E8F0'}`,
                              borderRadius: '6px',
                              cursor: 'pointer'
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                              <span style={{ fontWeight: '700', fontSize: '0.74rem', color: ASPIRE_THEME.greenNew }}>{title}</span>
                              <span style={{ fontSize: '0.64rem', background: '#DCFCE7', padding: '1px 5px', borderRadius: '3px' }}>{sub}</span>
                            </div>
                            <textarea
                              placeholder="Justificación del alta..."
                              value={comments[key] || ''}
                              onChange={(e) => handleCommentChange(key, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              style={{ width: '100%', minHeight: '40px', padding: '0.35rem', border: `1px solid ${ASPIRE_THEME.border}`, borderRadius: '4px', fontSize: '0.7rem', boxSizing: 'border-box' }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* 4. Zonas / Áreas Eliminadas */}
              {report.eliminadas.length > 0 && (
                <div style={{ border: '1px solid #FECDD3', borderRadius: '8px', overflow: 'hidden' }}>
                  <button
                    onClick={() => toggleSection('eliminadas')}
                    style={{
                      width: '100%',
                      padding: '0.55rem 0.75rem',
                      background: '#FEF2F2',
                      border: 'none',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      cursor: 'pointer',
                      color: ASPIRE_THEME.redBase,
                      fontWeight: '700',
                      fontSize: '0.76rem'
                    }}
                  >
                    <span>➖ {grouping === 'area' ? 'Áreas Suprimidas' : 'Zonas Eliminadas'} ({report.eliminadas.length})</span>
                    <span>{openSections.eliminadas ? '▲' : '▼'}</span>
                  </button>
                  {openSections.eliminadas && (
                    <div style={{ padding: '0.65rem', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {report.eliminadas.map((z, idx) => {
                        const key = `elim-${z.codatzbs || z.area_cd || z.area_st}`;
                        const title = grouping === 'area' ? (z.area_st || z.nombre_area_normalizado) : z.n_zbs;
                        const sub = grouping === 'area' ? (z.area_cd ? `Cód: ${z.area_cd}` : 'Área base') : `Cód: ${z.codatzbs}`;

                        return (
                          <div
                            key={idx}
                            onClick={(e) => handleFocusIssue(z, 'elim', e)}
                            style={{
                              padding: '0.55rem',
                              background: '#F8FAFC',
                              border: `1px solid ${selectedIssueFocus?.issue === z ? ASPIRE_THEME.redBase : '#E2E8F0'}`,
                              borderRadius: '6px',
                              cursor: 'pointer'
                            }}
                          >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                              <span style={{ fontWeight: '700', fontSize: '0.74rem', color: ASPIRE_THEME.redBase, textDecoration: 'line-through' }}>{title}</span>
                              <span style={{ fontSize: '0.64rem', background: '#FEE2E2', padding: '1px 5px', borderRadius: '3px' }}>{sub}</span>
                            </div>
                            <textarea
                              placeholder="Motivo de la baja..."
                              value={comments[key] || ''}
                              onChange={(e) => handleCommentChange(key, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              style={{ width: '100%', minHeight: '40px', padding: '0.35rem', border: `1px solid ${ASPIRE_THEME.border}`, borderRadius: '4px', fontSize: '0.7rem', boxSizing: 'border-box' }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* 5. Cambios de Código y Nombre */}
              {report.cambioCodigo.length > 0 && (
                <div style={{ border: '1px solid #FDBA74', borderRadius: '8px', overflow: 'hidden' }}>
                  <button
                    onClick={() => toggleSection('cambioCodigo')}
                    style={{
                      width: '100%',
                      padding: '0.55rem 0.75rem',
                      background: '#FFF7ED',
                      border: 'none',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      cursor: 'pointer',
                      color: ASPIRE_THEME.orangeCode,
                      fontWeight: '700',
                      fontSize: '0.76rem'
                    }}
                  >
                    <span>🔀 Cambios de Código ({report.cambioCodigo.length})</span>
                    <span>{openSections.cambioCodigo ? '▲' : '▼'}</span>
                  </button>
                  {openSections.cambioCodigo && (
                    <div style={{ padding: '0.65rem', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {report.cambioCodigo.map((z, idx) => {
                        const key = `cod-${z.upProps.codatzbs || z.upProps.area_cd || z.upProps.area_st}`;
                        const label = grouping === 'area' ? (z.baseProps.area_st || z.baseProps.nombre_area_normalizado) : z.baseProps.n_zbs;
                        const prevCode = grouping === 'area' ? z.baseProps.area_cd : z.baseProps.codatzbs;
                        const newCode = grouping === 'area' ? z.upProps.area_cd : z.upProps.codatzbs;

                        return (
                          <div
                            key={idx}
                            onClick={(e) => handleFocusIssue(z, 'cod', e)}
                            style={{
                              padding: '0.55rem',
                              background: '#F8FAFC',
                              border: `1px solid ${selectedIssueFocus?.issue === z ? ASPIRE_THEME.orangeCode : '#E2E8F0'}`,
                              borderRadius: '6px',
                              cursor: 'pointer'
                            }}
                          >
                            <div style={{ fontWeight: '700', fontSize: '0.74rem', color: ASPIRE_THEME.orangeCode }}>{label}</div>
                            <div style={{ fontSize: '0.68rem', margin: '2px 0 4px 0' }}>
                              <s>{prevCode || '(Sin código)'}</s> ➔ <strong>{newCode || '(Nuevo)'}</strong>
                            </div>
                            <textarea
                              placeholder="Motivo..."
                              value={comments[key] || ''}
                              onChange={(e) => handleCommentChange(key, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              style={{ width: '100%', minHeight: '40px', padding: '0.35rem', border: `1px solid ${ASPIRE_THEME.border}`, borderRadius: '4px', fontSize: '0.7rem', boxSizing: 'border-box' }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* 6. Movidas / Reestructuraciones */}
              {report.movidas.length > 0 && (
                <div style={{ border: '1px solid #E2E8F0', borderRadius: '8px', overflow: 'hidden' }}>
                  <button
                    onClick={() => toggleSection('movidas')}
                    style={{
                      width: '100%',
                      padding: '0.55rem 0.75rem',
                      background: '#F8FAFC',
                      border: 'none',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      cursor: 'pointer',
                      color: ASPIRE_THEME.black,
                      fontWeight: '700',
                      fontSize: '0.76rem'
                    }}
                  >
                    <span>🔄 {grouping === 'area' ? 'Variación de ZBS por Área' : 'Cambios de Área'} ({report.movidas.length})</span>
                    <span>{openSections.movidas ? '▲' : '▼'}</span>
                  </button>
                  {openSections.movidas && (
                    <div style={{ padding: '0.65rem', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {report.movidas.map((z, idx) => {
                        const key = `mov-${z.code}`;
                        return (
                          <div
                            key={idx}
                            onClick={(e) => handleFocusIssue(z, 'mov', e)}
                            style={{
                              padding: '0.55rem',
                              background: '#FFFFFF',
                              border: `1px solid ${selectedIssueFocus?.issue === z ? ASPIRE_THEME.blue : '#E2E8F0'}`,
                              borderRadius: '6px',
                              cursor: 'pointer'
                            }}
                          >
                            <div style={{ fontWeight: '700', fontSize: '0.74rem', color: ASPIRE_THEME.blue }}>
                              {grouping === 'area' ? `Área: ${z.code}` : (z.upProps?.n_zbs || z.code)}
                            </div>
                            <div style={{ fontSize: '0.68rem', margin: '2px 0 4px 0', color: ASPIRE_THEME.textSecondary }}>
                              {grouping === 'area'
                                ? `Integración: ${z.baseProps?.total_zbs || 0} ZBS ➔ ${z.upProps?.total_zbs || 0} ZBS`
                                : `De "${z.baseProps?.area || z.baseProps?.area_st}" ➔ "${z.upProps?.area || z.upProps?.area_st}"`}
                            </div>
                            <textarea
                              placeholder="Justificación del cambio..."
                              value={comments[key] || ''}
                              onChange={(e) => handleCommentChange(key, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              style={{ width: '100%', minHeight: '40px', padding: '0.35rem', border: `1px solid ${ASPIRE_THEME.border}`, borderRadius: '4px', fontSize: '0.7rem', boxSizing: 'border-box' }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* 7. Renombradas */}
              {report.renombradas.length > 0 && (
                <div style={{ border: '1px solid #FBCFE8', borderRadius: '8px', overflow: 'hidden' }}>
                  <button
                    onClick={() => toggleSection('renombradas')}
                    style={{
                      width: '100%',
                      padding: '0.55rem 0.75rem',
                      background: '#FDF2F8',
                      border: 'none',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      cursor: 'pointer',
                      color: ASPIRE_THEME.pinkRen,
                      fontWeight: '700',
                      fontSize: '0.76rem'
                    }}
                  >
                    <span>🏷️ Renombradas ({report.renombradas.length})</span>
                    <span>{openSections.renombradas ? '▲' : '▼'}</span>
                  </button>
                  {openSections.renombradas && (
                    <div style={{ padding: '0.65rem', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {report.renombradas.map((z, idx) => {
                        const key = `ren-${z.code}`;
                        const prevName = grouping === 'area' ? z.baseProps.area_st : z.baseProps.n_zbs;
                        const newName = grouping === 'area' ? z.upProps.area_st : z.upProps.n_zbs;

                        return (
                          <div
                            key={idx}
                            onClick={(e) => handleFocusIssue(z, 'ren', e)}
                            style={{
                              padding: '0.55rem',
                              background: '#F8FAFC',
                              border: `1px solid ${selectedIssueFocus?.issue === z ? ASPIRE_THEME.pinkRen : '#E2E8F0'}`,
                              borderRadius: '6px',
                              cursor: 'pointer'
                            }}
                          >
                            <div style={{ fontSize: '0.72rem', color: ASPIRE_THEME.pinkRen, fontWeight: '700' }}>
                              <s>{prevName}</s> ➔ <strong>{newName}</strong>
                            </div>
                            <div style={{ fontSize: '0.64rem', color: ASPIRE_THEME.textSecondary, marginTop: '2px' }}>
                              Cód: {z.code}
                            </div>
                            <textarea
                              placeholder="Justificación del renombrado toponímico..."
                              value={comments[key] || ''}
                              onChange={(e) => handleCommentChange(key, e.target.value)}
                              onClick={(e) => e.stopPropagation()}
                              style={{ width: '100%', minHeight: '40px', padding: '0.35rem', border: `1px solid ${ASPIRE_THEME.border}`, borderRadius: '4px', fontSize: '0.7rem', boxSizing: 'border-box' }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* Estado cuando la cartografía es idéntica */}
              {qaKpis?.totalIssues === 0 && (
                <div style={{ background: '#ECFDF5', color: '#065F46', padding: '1rem', borderRadius: '8px', textAlign: 'center', fontWeight: '700', border: '1px solid #A7F3D0', fontSize: '0.78rem' }}>
                  ✅ La cartografía subida es espacial y atributivamente idéntica a la oficial de {baseYear} ({grouping === 'area' ? 'a nivel de Áreas de Salud' : 'a nivel de ZBS'}).
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* LIENZO MAPLIBRE GL A PANTALLA COMPLETA CON CONTROLES FLOTANTES */}
      <main
        style={{
          display: isMobile && mobileTab !== 'map' ? 'none' : 'block',
          flex: 1,
          backgroundColor: '#ffffff',
          position: 'relative',
          height: '100%',
          minHeight: 0,
          minWidth: 0,
          width: '100%',
          boxSizing: 'border-box',
          overflow: 'hidden'
        }}
      >
        {/* Spinner flotante de estado y overlay de fusión */}
        {loading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              zIndex: 35,
              backgroundColor: 'rgba(255, 255, 255, 0.72)',
              backdropFilter: 'blur(4px)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '12px',
              pointerEvents: 'all'
            }}
          >
            <div
              style={{
                backgroundColor: '#ffffff',
                border: `1.5px solid ${ASPIRE_THEME.blue}`,
                borderRadius: '12px',
                padding: '1.1rem 1.6rem',
                boxShadow: '0 12px 28px -5px rgba(0,0,0,0.18)',
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                maxWidth: '90%'
              }}
            >
              <div
                style={{
                  width: '28px',
                  height: '28px',
                  border: `3px solid rgba(60, 100, 163, 0.2)`,
                  borderTopColor: ASPIRE_THEME.blue,
                  borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                  flexShrink: 0
                }}
              />
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <span style={{ fontSize: '0.84rem', fontWeight: '700', color: ASPIRE_THEME.black }}>
                  {grouping === 'area' ? 'Fusionando Áreas de Salud...' : 'Procesando geometrías...'}
                </span>
                <span style={{ fontSize: '0.72rem', color: ASPIRE_THEME.textSecondary, marginTop: '2px' }}>
                  {processingStatus || 'Disolviendo polígonos con DuckDB Spatial...'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Panel Flotante de Control de Capas y Opacidades */}
        <div
          style={{
            position: 'absolute',
            top: '12px',
            right: isMobile ? '12px' : '55px',
            zIndex: 20,
            backgroundColor: 'rgba(255, 255, 255, 0.96)',
            backdropFilter: 'blur(4px)',
            borderRadius: '10px',
            padding: '8px 12px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
            border: `1px solid ${ASPIRE_THEME.border}`,
            fontSize: '0.7rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            minWidth: '200px'
          }}
        >
          <span style={{ fontWeight: '700', color: ASPIRE_THEME.black }}>Capas y Superposición</span>

          {/* Capa Base Oficial */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', color: '#991B1B', fontWeight: '600' }}>
              <input
                type="checkbox"
                checked={showBaseLayer}
                onChange={(e) => setShowBaseLayer(e.target.checked)}
                style={{ accentColor: ASPIRE_THEME.redBase, cursor: 'pointer' }}
              />
              <span>Base 2024</span>
            </label>
            <input
              type="range"
              min="0.05"
              max="0.8"
              step="0.05"
              value={baseOpacity}
              onChange={(e) => setBaseOpacity(parseFloat(e.target.value))}
              style={{ width: '65px', accentColor: ASPIRE_THEME.redBase }}
              title="Opacidad base"
            />
          </div>

          {/* Capa Subida Propuesta */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', color: ASPIRE_THEME.blue, fontWeight: '600' }}>
              <input
                type="checkbox"
                checked={showUpLayer}
                onChange={(e) => setShowUpLayer(e.target.checked)}
                style={{ accentColor: ASPIRE_THEME.blue, cursor: 'pointer' }}
              />
              <span>Subida (Nueva)</span>
            </label>
            <input
              type="range"
              min="0.05"
              max="0.8"
              step="0.05"
              value={upOpacity}
              onChange={(e) => setUpOpacity(parseFloat(e.target.value))}
              style={{ width: '65px', accentColor: ASPIRE_THEME.blue }}
              title="Opacidad subida"
            />
          </div>
        </div>

        {/* Tarjeta de incidencia activa enfocada */}
        {selectedIssueFocus && (
          <div
            style={{
              position: 'absolute',
              bottom: '16px',
              left: '16px',
              zIndex: 20,
              backgroundColor: 'rgba(255, 255, 255, 0.98)',
              backdropFilter: 'blur(6px)',
              border: `1.5px solid ${ASPIRE_THEME.blue}`,
              borderRadius: '10px',
              padding: '8px 12px',
              boxShadow: '0 6px 18px rgba(0,0,0,0.14)',
              maxWidth: '380px',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              fontSize: '0.74rem'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: '700', color: ASPIRE_THEME.blue }}>
                🔍 Incidencia en Foco {grouping === 'area' ? '(Área)' : '(ZBS)'}
              </span>
              <button
                onClick={() => setSelectedIssueFocus(null)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.85rem' }}
              >
                ×
              </button>
            </div>
            <div style={{ fontSize: '0.72rem', color: ASPIRE_THEME.black }}>
              {selectedIssueFocus.issue.area_st ||
                selectedIssueFocus.issue.nombre_area_normalizado ||
                selectedIssueFocus.issue.n_zbs ||
                selectedIssueFocus.issue.nom ||
                selectedIssueFocus.issue.newNom ||
                selectedIssueFocus.issue.baseProps?.n_zbs ||
                selectedIssueFocus.issue.baseProps?.area_st ||
                'Zona seleccionada'}
            </div>
          </div>
        )}

        <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
      </main>
    </div>
  );
}