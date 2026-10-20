import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import shpwrite from 'shp-write';
import { COMUNIDADES, CCAA_COLORS, runDuckDBFusion, initDuckDB } from '../utils/geoUtils';

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
  border: '#E2E8F0',
  borderDark: '#CBD5E1',
  tableHeader: '#F1F5F9',
  tableRowEven: '#FFFFFF',
  tableRowOdd: '#F8FAFC',
  selectedBorder: '#0F172A',
  selectedGlow: 'rgba(60, 100, 163, 0.25)'
};

// Paleta cromática de alto contraste para distinguir visualmente cada Área de Salud
export const AREA_PALETTE = [
  '#0284C7', '#0D9488', '#059669', '#16A34A', '#65A30D',
  '#CA8A04', '#D97706', '#EA580C', '#DC2626', '#E11D48',
  '#C026D3', '#9333EA', '#7C3AED', '#4F46E5', '#2563EB',
  '#0891B2', '#047857', '#B45309', '#BE185D', '#6366F1'
];

const ETRS89_PRJ = 'GEOGCS["GCS_ETRS_1989",DATUM["D_ETRS_1989",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';


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


const stringPool = new Map();
const intern = (str) => {
  if (str === null || str === undefined) return '';
  const trimmed = String(str).trim();
  let existing = stringPool.get(trimmed);
  if (!existing) {
    stringPool.set(trimmed, trimmed);
    existing = trimmed;
  }
  return existing;
};

export const formatZbsDisplayName = (name, code = '') => {
  if (!name && !code) return 'ZBS: Desconocida';
  const clean = String(name || code).replace(/^ZBS[\s:_-]*/i, '').trim();
  return `ZBS: ${clean || code}`;
};

const calculateGeometryCentroid = (geom) => {
  if (!geom || !geom.coordinates) return null;
  let totalLon = 0;
  let totalLat = 0;
  let count = 0;

  const extractPoints = (coords) => {
    if (typeof coords[0] === 'number') {
      totalLon += coords[0];
      totalLat += coords[1];
      count++;
    } else if (Array.isArray(coords)) {
      coords.forEach(extractPoints);
    }
  };

  extractPoints(geom.coordinates);
  return count > 0 ? [totalLon / count, totalLat / count] : null;
};

// ============================================================================
// PARSER WKB DE ALTA VELOCIDAD (Compatible con la columna geom de DuckDB)
// ============================================================================
function parseWKB(bufferOrView) {
  if (!bufferOrView) return null;

  if (typeof bufferOrView === 'string') {
    const trimmed = bufferOrView.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch (_) {}
    }
    if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      const bytes = new Uint8Array(trimmed.length / 2);
      for (let i = 0; i < trimmed.length; i += 2) {
        bytes[i / 2] = parseInt(trimmed.substring(i, i + 2), 16);
      }
      return parseWKB(bytes);
    }
    return null;
  }

  let bytes = null;
  if (bufferOrView instanceof Uint8Array) {
    bytes = bufferOrView;
  } else if (Array.isArray(bufferOrView)) {
    bytes = new Uint8Array(bufferOrView);
  } else if (bufferOrView?.buffer) {
    bytes = new Uint8Array(
      bufferOrView.buffer,
      bufferOrView.byteOffset || 0,
      bufferOrView.byteLength || bufferOrView.length
    );
  } else if (bufferOrView && typeof bufferOrView[Symbol.iterator] === 'function') {
    bytes = new Uint8Array(Array.from(bufferOrView));
  }

  if (!bytes || bytes.length < 5) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;

  function readSubGeometry() {
    if (offset + 5 > bytes.length) return null;
    const isLittle = view.getUint8(offset) === 1;
    offset += 1;

    const rawType = view.getUint32(offset, isLittle);
    offset += 4;

    const hasSRID = (rawType & 0x20000000) !== 0;
    if (hasSRID) {
      offset += 4;
    }

    const geomType = rawType & 0xff;

    if (geomType === 1) { // Point
      const x = view.getFloat64(offset, isLittle); offset += 8;
      const y = view.getFloat64(offset, isLittle); offset += 8;
      return {
        type: 'Point',
        coordinates: [Math.round(x * 100000) / 100000, Math.round(y * 100000) / 100000]
      };
    }

    if (geomType === 3) { // Polygon
      const numRings = view.getUint32(offset, isLittle); offset += 4;
      const rings = [];
      for (let r = 0; r < numRings; r++) {
        const numPoints = view.getUint32(offset, isLittle); offset += 4;
        const pts = [];
        for (let p = 0; p < numPoints; p++) {
          const x = view.getFloat64(offset, isLittle); offset += 8;
          const y = view.getFloat64(offset, isLittle); offset += 8;
          pts.push([Math.round(x * 100000) / 100000, Math.round(y * 100000) / 100000]);
        }
        rings.push(pts);
      }
      return { type: 'Polygon', coordinates: rings };
    }

    if (geomType === 6) { // MultiPolygon
      const numPolys = view.getUint32(offset, isLittle); offset += 4;
      const polys = [];
      for (let m = 0; m < numPolys; m++) {
        const sub = readSubGeometry();
        if (sub && sub.type === 'Polygon') {
          polys.push(sub.coordinates);
        }
      }
      return { type: 'MultiPolygon', coordinates: polys };
    }

    if (geomType === 2) { // LineString
      const numPoints = view.getUint32(offset, isLittle); offset += 4;
      const pts = [];
      for (let p = 0; p < numPoints; p++) {
        const x = view.getFloat64(offset, isLittle); offset += 8;
        const y = view.getFloat64(offset, isLittle); offset += 8;
        pts.push([Math.round(x * 100000) / 100000, Math.round(y * 100000) / 100000]);
      }
      return { type: 'LineString', coordinates: pts };
    }

    return null;
  }

  try {
    return readSubGeometry();
  } catch (err) {
    console.warn('Fallo al parsear WKB:', err);
    return null;
  }
}

// Sanitizador de filas DuckDB (elimina BigInt incompatible con JSON.stringify)
function sanitizeDuckDBValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  return v;
}

function sanitizeDuckDBRow(row) {
  const clean = {};
  for (const [key, val] of Object.entries(row)) {
    if (key === 'geom') continue;
    clean[key] = sanitizeDuckDBValue(val);
  }
  return clean;
}

// ============================================================================
// GENERACIÓN DINÁMICA DE AÑOS
// ============================================================================
const CURRENT_YEAR = new Date().getFullYear();
const DEFAULT_YEARS_2022_TO_CURRENT = (() => {
  const list = [];
  for (let y = 2022; y <= Math.max(2026, CURRENT_YEAR); y++) {
    list.push(String(y));
  }
  return list;
})();

export default function VisorZBSAreas() {
  const [year, setYear] = useState('2024');
  const [availableYears, setAvailableYears] = useState(DEFAULT_YEARS_2022_TO_CURRENT);
  const [selectedCCAA, setSelectedCCAA] = useState(['ES30']);
  const [grouping, setGrouping] = useState('zbs'); // 'zbs' | 'area'

  const [loading, setLoading] = useState(false);
  const [processingMode, setProcessingMode] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [parquetFileName, setParquetFileName] = useState('spain_zbs_historico.parquet');
  const [totalRowsAvailable, setTotalRowsAvailable] = useState(0);
  const [duckdbReady, setDuckdbReady] = useState(false);

  // Selección múltiple de shapes
  const [selectedShapesMap, setSelectedShapesMap] = useState(new Map());
  const [multiSelectMode, setMultiSelectMode] = useState(false);

  // Estados de tabla de atributos
  const [tableSearchFilter, setTableSearchFilter] = useState('');
  const [isTableModalOpen, setIsTableModalOpen] = useState(false);
  const [sortConfig, setSortConfig] = useState({ key: 'displayName', direction: 'asc' });
  const [tableMode, setTableMode] = useState('selected'); // 'selected' | 'all'

  // Detección responsive
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1200
  );
  const isMobile = windowWidth < 1024;
  const [mobileTab, setMobileTab] = useState('panel');

  useEffect(() => {
    const handleResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const mapContainer = useRef(null);
  const mapRef = useRef(null);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapLibreReady, setMapLibreReady] = useState(false);

  const displayedGeoJSONRef = useRef({ type: 'FeatureCollection', features: [] });
  const featureLookupRef = useRef(new Map());
  const duckDbConnRef = useRef(null);


  // Inicialización de DuckDB-WASM y precarga automática de spain_zbs_historico.parquet
  useEffect(() => {
    let isSubscribed = true;

    const init = async () => {
      try {
        setLoading(true);
        setProcessingMode('Iniciando motor DuckDB-Wasm Spatial...');
        const db = await initDuckDB();
        const conn = await db.connect();
        duckDbConnRef.current = conn;

        const baseUrl = import.meta.env?.BASE_URL || '/';
        const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

        const candidateUrls = [
          `${normalizedBase}data/spain_zbs_historico.parquet`,
        ];

        let loaded = false;
        for (const url of candidateUrls) {
          try {
            const res = await fetch(url);
            if (res.ok) {
              const ct = res.headers.get('content-type') || '';
              if (ct.includes('text/html')) continue;
              const buf = await res.arrayBuffer();
              if (buf.byteLength > 1000) {
                await db.registerFileBuffer('spain_zbs_historico.parquet', new Uint8Array(buf));
                loaded = true;
                break;
              }
            }
          } catch (_) {}
        }

        if (!isSubscribed) return;

        if (loaded) {
          try {
            const countRes = await conn.query("SELECT count(*)::INT as c FROM read_parquet('spain_zbs_historico.parquet')");
            const count = countRes.toArray()[0]?.c || 0;
            setTotalRowsAvailable(Number(count));
          } catch (_) {}
        }

        setDuckdbReady(true);
      } catch (err) {
        console.error('Error al inicializar DuckDB-WASM:', err);
      } finally {
        if (isSubscribed) setLoading(false);
      }
    };

    init();

    return () => {
      isSubscribed = false;
    };
  }, []);

  // Carga de MapLibre GL
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

    // Inyectar polygon-clipping UMD para soporte nativo directo
    if (!document.getElementById('polygon-clipping-umd')) {
      const pcScript = document.createElement('script');
      pcScript.id = 'polygon-clipping-umd';
      pcScript.src = 'https://unpkg.com/polygon-clipping@0.15.7/dist/polygon-clipping.umd.js';
      pcScript.async = true;
      document.head.appendChild(pcScript);
    }
  }, []);

  // Inicialización de MapLibre GL
  useEffect(() => {
    if (!mapLibreReady || !mapContainer.current || mapRef.current) return;

    try {
      const map = new window.maplibregl.Map({
        container: mapContainer.current,
        style: 'https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json',
        center: [-4.5, 36.5],
        zoom: isMobile ? 5.2 : 4.8
      });

      map.addControl(new window.maplibregl.NavigationControl(), 'top-right');

      map.on('load', () => {
        map.addSource('fusion-source', {
          type: 'geojson',
          data: displayedGeoJSONRef.current,
          promoteId: 'feature_id'
        });

        map.addLayer({
          id: 'fusion-fills',
          type: 'fill',
          source: 'fusion-source',
          paint: {
            'fill-color': ['coalesce', ['get', 'color'], ASPIRE_THEME.blue],
            'fill-opacity': [
              'case',
              ['boolean', ['feature-state', 'selected'], false],
              0.92,
              ['boolean', ['feature-state', 'hover'], false],
              0.84,
              0.68
            ]
          }
        });

        map.addLayer({
          id: 'fusion-lines',
          type: 'line',
          source: 'fusion-source',
          paint: {
            'line-color': [
              'case',
              ['boolean', ['feature-state', 'selected'], false],
              ASPIRE_THEME.black,
              '#ffffff'
            ],
            'line-width': [
              'case',
              ['boolean', ['feature-state', 'selected'], false],
              3.6,
              1.2
            ],
            'line-opacity': 0.95
          }
        });

        const hoverPopup = new window.maplibregl.Popup({
          closeButton: false,
          closeOnClick: false,
          offset: 10
        });

        let hoveredId = null;

        map.on('mousemove', 'fusion-fills', (e) => {
          if (!e.features || !e.features.length) return;
          map.getCanvas().style.cursor = 'pointer';
          const feat = e.features[0];
          const fId = feat.properties.feature_id;

          if (hoveredId !== fId) {
            if (hoveredId) {
              map.setFeatureState({ source: 'fusion-source', id: hoveredId }, { hover: false });
            }
            hoveredId = fId;
            map.setFeatureState({ source: 'fusion-source', id: fId }, { hover: true });
          }

          const p = feat.properties;
          const ccaaName = COMUNIDADES.find(c => c.id === p.ccaa_id || c.id === p.ccaa_cd)?.nombre || p.ccaa_cd || p.ccaa_id;

          if (p.is_area) {
            hoverPopup
              .setLngLat(e.lngLat)
              .setHTML(`
                <div style="font-family:system-ui,sans-serif;padding:3px 5px;line-height:1.35;">
                  <div style="color:${ASPIRE_THEME.blue};font-weight:700;font-size:12px;">Área: ${p.area_st || p.nombre_area_normalizado}</div>
                  <div style="font-size:10px;color:${ASPIRE_THEME.gray};margin-top:2px;">
                    ${ccaaName} • <strong>${p.total_zbs || 1} ZBS integradas</strong>
                  </div>
                  <div style="font-size:9px;color:${ASPIRE_THEME.teal};margin-top:3px;font-weight:600;">
                    Área de Salud fusionada
                  </div>
                </div>
              `)
              .addTo(map);
          } else {
            const title = formatZbsDisplayName(p.nombre_zbs_normalizado, p.zbs_cd || p.codatzbs);
            hoverPopup
              .setLngLat(e.lngLat)
              .setHTML(`
                <div style="font-family:system-ui,sans-serif;padding:3px 5px;line-height:1.3;">
                  <div style="color:${ASPIRE_THEME.blue};font-weight:700;font-size:11.5px;">${title}</div>
                  <div style="font-size:10px;color:${ASPIRE_THEME.gray};margin-top:2px;">
                    ${ccaaName} • Área: ${p.area_st || p.nombre_area_normalizado}
                  </div>
                  <div style="font-size:9px;color:${ASPIRE_THEME.textSecondary};margin-top:2px;">
                    Vigencia: [${p.valid_from ?? 'Inicio'} ➔ ${p.valid_to ?? 'Actual'}]
                  </div>
                  <div style="font-size:9px;color:${ASPIRE_THEME.teal};margin-top:3px;font-weight:600;">
                    Clic para seleccionar • Shift/Ctrl para multiselección
                  </div>
                </div>
              `)
              .addTo(map);
          }
        });

        map.on('mouseleave', 'fusion-fills', () => {
          map.getCanvas().style.cursor = '';
          hoverPopup.remove();
          if (hoveredId) {
            map.setFeatureState({ source: 'fusion-source', id: hoveredId }, { hover: false });
            hoveredId = null;
          }
        });

        map.on('click', 'fusion-fills', (e) => {
          if (!e.features || !e.features.length) return;
          const p = e.features[0].properties;
          const fId = p.feature_id;
          const featRecord = featureLookupRef.current.get(fId) || p;

          const isCumulative = e.originalEvent?.shiftKey ||
                               e.originalEvent?.ctrlKey ||
                               e.originalEvent?.metaKey ||
                               multiSelectMode;

          const rawProps = featRecord.raw_properties || featRecord;
          const combinedProps = { ...rawProps, ...p };

          const shapePayload = {
            ...featRecord,
            feature_id: fId,
            geometry: e.features[0].geometry,
            allProperties: combinedProps,
            displayName: p.is_area
              ? (p.area_st || p.nombre_area_normalizado)
              : formatZbsDisplayName(p.nombre_zbs_normalizado, p.zbs_cd || p.codatzbs),
            ccaaNombre: COMUNIDADES.find(c => c.id === p.ccaa_id || c.id === p.ccaa_cd)?.nombre || p.ccaa_cd || p.ccaa_id
          };

          setSelectedShapesMap(prev => {
            const next = new Map(isCumulative ? prev : []);
            if (next.has(fId)) {
              next.delete(fId);
            } else {
              next.set(fId, shapePayload);
            }
            return next;
          });
        });

        mapRef.current = map;
        setMapLoaded(true);
      });
    } catch (err) {
      console.error('Error al iniciar MapLibre en VisorZBSAreas:', err);
    }

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [mapLibreReady, isMobile, multiSelectMode]);

  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;

    featureLookupRef.current.forEach((_, id) => {
      try {
        map.setFeatureState(
          { source: 'fusion-source', id },
          { selected: selectedShapesMap.has(id) }
        );
      } catch (_) {}
    });

    // Actualizar estilo de contorno según nivel territorial
    if (map.getLayer('fusion-lines')) {
      map.setPaintProperty(
        'fusion-lines',
        'line-color',
        grouping === 'area'
          ? ['case', ['boolean', ['feature-state', 'selected'], false], '#ffffff', '#0F172A']
          : ['case', ['boolean', ['feature-state', 'selected'], false], ASPIRE_THEME.black, '#ffffff']
      );
      map.setPaintProperty(
        'fusion-lines',
        'line-width',
        grouping === 'area'
          ? ['case', ['boolean', ['feature-state', 'selected'], false], 4.2, 2.2]
          : ['case', ['boolean', ['feature-state', 'selected'], false], 3.2, 1.1]
      );
    }
  }, [selectedShapesMap, mapLoaded, grouping]);

  // ============================================================================
  // EJECUCIÓN DE CONSULTA SQL SCD TIPO 2 EN DUCKDB-WASM AL CAMBIAR AÑO / CCAA
  // ============================================================================
  useEffect(() => {
    if (!duckdbReady || !duckDbConnRef.current || selectedCCAA.length === 0) {
      displayedGeoJSONRef.current = { type: 'FeatureCollection', features: [] };
      featureLookupRef.current.clear();
      if (mapRef.current && mapLoaded) {
        const src = mapRef.current.getSource('fusion-source');
        if (src) src.setData(displayedGeoJSONRef.current);
      }
      return;
    }

    let isSubscribed = true;
    setLoading(true);
    setProcessingMode(grouping === 'area' ? 'DuckDB SQL: Fusionando y disolviendo áreas por area_st...' : `DuckDB SQL: Filtrando vigencia año ${year}...`);
    setSelectedShapesMap(new Map());

    const ejecutarConsultaSQL = async () => {
      try {
        const conn = duckDbConnRef.current;
        const targetYearInt = parseInt(year, 10);
        const ccaaFilterList = selectedCCAA.map(c => `'${c}'`).join(',');

        // 1. Filtrado de registros activos para el año seleccionado usando SQL directo
        const sqlQuery = `
          SELECT 
            CAST(OGC_FID AS VARCHAR) as OGC_FID,
            CAST(ccaa_cd AS VARCHAR) as ccaa_cd,
            CAST(id_zbs AS VARCHAR) as id_zbs,
            CAST(zbs_cd AS VARCHAR) as zbs_cd,
            CAST(zbs_st AS VARCHAR) as zbs_st,
            CAST(area_id AS VARCHAR) as area_id,
            CAST(area_cd AS VARCHAR) as area_cd,
            CAST(area_st AS VARCHAR) as area_st,
            CAST(valid_from AS VARCHAR) as valid_from,
            CAST(valid_to AS VARCHAR) as valid_to,
            CAST("version" AS VARCHAR) as "version",
            CAST(created_at AS VARCHAR) as created_at,
            geom
          FROM read_parquet('${parquetFileName}')
          WHERE ccaa_cd IN (${ccaaFilterList})
            AND (
              valid_from IS NULL 
              OR TRIM(CAST(valid_from AS VARCHAR)) IN ('', 'None', 'null', 'NULL')
              OR TRY_CAST(SUBSTR(CAST(valid_from AS VARCHAR), 1, 4) AS INT) <= ${targetYearInt}
            )
            AND (
              valid_to IS NULL 
              OR TRIM(CAST(valid_to AS VARCHAR)) IN ('', 'None', 'null', 'NULL')
              OR TRY_CAST(SUBSTR(CAST(valid_to AS VARCHAR), 1, 4) AS INT) > ${targetYearInt}
            )
        `;

        const queryResult = await conn.query(sqlQuery);
        if (!isSubscribed) return;

        const rows = queryResult.toArray();
        const activeFeatures = [];

        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          const rawGeom = row.geom;
          const parsedGeometry = parseWKB(rawGeom);
          if (!parsedGeometry) continue;

          // Sanitizar fila eliminando cualquier tipo BigInt
          const cleanRow = sanitizeDuckDBRow(row);

          const ccaaCd = intern(String(cleanRow.ccaa_cd || '').trim());
          const zbsCd = intern(String(cleanRow.zbs_cd || '').replace(/\.0+$/, '').trim());
          const zbsSt = intern(String(cleanRow.zbs_st || '').trim());
          const areaSt = intern(String(cleanRow.area_st || 'Desconocida').trim());
          const fId = intern(`${ccaaCd}_${zbsCd}_v${cleanRow.version || cleanRow.valid_from || i}`);
          const baseColor = CCAA_COLORS[ccaaCd] || ASPIRE_THEME.blue;

          const cleanProps = {
            feature_id: fId,
            OGC_FID: cleanRow.OGC_FID,
            ccaa_cd: ccaaCd,
            ccaa_id: ccaaCd,
            id_zbs: cleanRow.id_zbs,
            zbs_cd: zbsCd,
            zbs_st: zbsSt,
            area_id: cleanRow.area_id,
            area_cd: cleanRow.area_cd,
            area_st: areaSt,
            valid_from: cleanRow.valid_from,
            valid_to: cleanRow.valid_to,
            version: cleanRow.version,
            created_at: cleanRow.created_at,
            codatzbs: zbsCd,
            n_zbs: zbsSt,
            area: areaSt,
            nombre_zbs_normalizado: intern(zbsSt || zbsCd),
            nombre_area_normalizado: intern(areaSt),
            color: baseColor,
            is_area: false
          };

          activeFeatures.push({
            type: 'Feature',
            id: fId,
            geometry: parsedGeometry,
            raw_properties: cleanRow,
            properties: cleanProps
          });
        }

        if (grouping === 'zbs') {
          const fc = { type: 'FeatureCollection', features: activeFeatures };
          displayedGeoJSONRef.current = fc;

          featureLookupRef.current.clear();
          activeFeatures.forEach(f => {
            featureLookupRef.current.set(f.properties.feature_id, {
              ...f.properties,
              geometry: f.geometry,
              raw_properties: f.raw_properties || f.properties
            });
          });

          if (mapRef.current && mapLoaded) {
            const src = mapRef.current.getSource('fusion-source');
            if (src) src.setData(fc);
          }
          setLoading(false);
          return;
        }

        // ====================================================================
        // FUSIÓN Y DISOLUCIÓN TOPOLÓGICA REAL VÍA DUCKDB SPATIAL
        // Elimina aristas compartidas para que no se vean polígonos internos
        // ====================================================================
        setProcessingMode('DuckDB Spatial: Disolviendo fronteras interiores por área...');
        const mergedAreasRaw = await runDuckDBFusion(activeFeatures, 'parquet_areas');
        if (!isSubscribed) return;

        // Asignar colores por Área de Salud
        const mergedAreaFeatures = mergedAreasRaw.map((f, idx) => {
          const color = AREA_PALETTE[idx % AREA_PALETTE.length];
          return {
            ...f,
            properties: {
              ...f.properties,
              color,
              displayName: f.properties.area_st
            }
          };
        });

        const fc = { type: 'FeatureCollection', features: mergedAreaFeatures };
        displayedGeoJSONRef.current = fc;

        featureLookupRef.current.clear();
        mergedAreaFeatures.forEach(f => {
          featureLookupRef.current.set(f.properties.feature_id, {
            ...f.properties,
            geometry: f.geometry,
            raw_properties: f.properties
          });
        });

        if (mapRef.current && mapLoaded) {
          const src = mapRef.current.getSource('fusion-source');
          if (src) src.setData(fc);
        }
      } catch (err) {
        console.error('Error al ejecutar consulta DuckDB SQL:', err);
      } finally {
        if (isSubscribed) setLoading(false);
      }
    };

    ejecutarConsultaSQL();

    return () => {
      isSubscribed = false;
    };
  }, [duckdbReady, parquetFileName, year, selectedCCAA, grouping, mapLoaded]);



  const handleSelectAll = () => setSelectedCCAA(COMUNIDADES.map(c => c.id));
  const handleClearSelection = () => setSelectedCCAA([]);

  const filteredCCAA = useMemo(() => {
    if (!searchTerm.trim()) return COMUNIDADES;
    const q = searchTerm.toLowerCase();
    return COMUNIDADES.filter(c => c.nombre.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  }, [searchTerm]);

  const toggleCCAA = (id) => {
    setSelectedCCAA(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id]);
  };

  const handleSelectAllLoadedShapes = () => {
    const newMap = new Map();
    featureLookupRef.current.forEach((featRecord, fId) => {
      const p = featRecord.properties || featRecord;
      const rawProps = featRecord.raw_properties || p;
      newMap.set(fId, {
        ...featRecord,
        feature_id: fId,
        geometry: featRecord.geometry,
        allProperties: { ...rawProps, ...p },
        displayName: p.is_area
          ? (p.area_st || p.nombre_area_normalizado)
          : formatZbsDisplayName(p.nombre_zbs_normalizado, p.zbs_cd || p.codatzbs),
        ccaaNombre: COMUNIDADES.find(c => c.id === p.ccaa_id || c.id === p.ccaa_cd)?.nombre || p.ccaa_cd || p.ccaa_id
      });
    });
    setSelectedShapesMap(newMap);
  };

  const handleClearSelectedShapes = () => {
    setSelectedShapesMap(new Map());
  };

  const handleRemoveSingleShape = (fId, e) => {
    if (e) e.stopPropagation();
    setSelectedShapesMap(prev => {
      const next = new Map(prev);
      next.delete(fId);
      return next;
    });
  };

  const handleFocusShapeOnMap = (shape, e) => {
    if (e) e.stopPropagation();
    if (!mapRef.current || !shape) return;
    const center = calculateGeometryCentroid(shape.geometry);
    if (center) {
      mapRef.current.flyTo({ center, zoom: isMobile ? 8.5 : 9.5, duration: 750 });
      if (isMobile) setMobileTab('mapa');
    }
  };

  const targetShapesList = useMemo(() => {
    if (tableMode === 'all') {
      const allList = [];
      featureLookupRef.current.forEach((featRecord, fId) => {
        const p = featRecord.properties || featRecord;
        const rawProps = featRecord.raw_properties || p;
        allList.push({
          ...featRecord,
          feature_id: fId,
          geometry: featRecord.geometry,
          allProperties: { ...rawProps, ...p },
          displayName: p.is_area
            ? (p.area_st || p.nombre_area_normalizado)
            : formatZbsDisplayName(p.nombre_zbs_normalizado, p.zbs_cd || p.codatzbs),
          ccaaNombre: COMUNIDADES.find(c => c.id === p.ccaa_id || c.id === p.ccaa_cd)?.nombre || p.ccaa_cd || p.ccaa_id
        });
      });
      return allList;
    }
    return Array.from(selectedShapesMap.values());
  }, [tableMode, selectedShapesMap]);

  const allPropertyKeys = useMemo(() => {
    if (targetShapesList.length === 0) return [];
    const keysSet = new Set();
    const primaryPriority = [
      'displayName',
      'ccaaNombre',
      'zbs_cd',
      'zbs_st',
      'area_st',
      'valid_from',
      'valid_to',
      'version',
      'id_zbs',
      'area_cd',
      'area_id',
      'OGC_FID',
      'created_at'
    ];

    targetShapesList.forEach(shape => {
      const props = shape.allProperties || shape.properties || shape;
      Object.keys(props).forEach(k => {
        if (!['allProperties', 'raw_properties', 'color', 'feature_id', 'geometry', 'is_area', 'displayName', 'ccaaNombre', 'geom'].includes(k)) {
          keysSet.add(k);
        }
      });
    });

    const otherKeys = Array.from(keysSet).filter(k => !primaryPriority.includes(k)).sort();
    return [...primaryPriority.filter(k => keysSet.has(k) || ['displayName', 'ccaaNombre'].includes(k)), ...otherKeys];
  }, [targetShapesList]);

  const filteredAndSortedShapes = useMemo(() => {
    let list = [...targetShapesList];

    if (tableSearchFilter.trim()) {
      const q = tableSearchFilter.toLowerCase();
      list = list.filter(shape => {
        if (shape.displayName?.toLowerCase().includes(q)) return true;
        if (shape.ccaaNombre?.toLowerCase().includes(q)) return true;
        const props = shape.allProperties || shape.properties || {};
        return Object.values(props).some(v => String(v ?? '').toLowerCase().includes(q));
      });
    }

    if (sortConfig.key) {
      list.sort((a, b) => {
        let valA = a[sortConfig.key] ?? a.allProperties?.[sortConfig.key] ?? a.properties?.[sortConfig.key] ?? '';
        let valB = b[sortConfig.key] ?? b.allProperties?.[sortConfig.key] ?? b.properties?.[sortConfig.key] ?? '';

        if (typeof valA === 'number' && typeof valB === 'number') {
          return sortConfig.direction === 'asc' ? valA - valB : valB - valA;
        }

        valA = String(valA).toLowerCase();
        valB = String(valB).toLowerCase();
        return sortConfig.direction === 'asc' ? valA.localeCompare(valB) : valB.localeCompare(valA);
      });
    }

    return list;
  }, [targetShapesList, tableSearchFilter, sortConfig]);

  const handleHeaderSort = (key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc'
    }));
  };

  const exportTableToCSV = () => {
    if (targetShapesList.length === 0) return;
    const headers = ['Identificador', 'Comunidad', ...allPropertyKeys.filter(k => !['displayName', 'ccaaNombre'].includes(k))];

    const rows = filteredAndSortedShapes.map(shape => {
      const p = shape.allProperties || shape.properties || {};
      return [
        `"${String(shape.displayName || '').replace(/"/g, '""')}"`,
        `"${String(shape.ccaaNombre || '').replace(/"/g, '""')}"`,
        ...headers.slice(2).map(h => {
          const val = p[h] ?? shape[h] ?? '';
          const str = typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val);
          return `"${str.replace(/"/g, '""')}"`;
        })
      ].join(';');
    });

    const csvContent = '\uFEFF' + [headers.join(';'), ...rows].join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `atributos_zbs_scd2_${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadGeoJSON = () => {
    const data = displayedGeoJSONRef.current;
    if (!data || !data.features || data.features.length === 0) return;

    const exportFeatures = data.features.map(f => {
      const p = f.properties || {};
      const raw = f.raw_properties || {};

      const exportedProperties = f.properties?.is_area
        ? {
            area_st: p.area_st || raw.area_st || '',
            area_cd: p.area_cd || raw.area_cd || '',
            area_id: p.area_id || raw.area_id || '',
            ccaa_cd: p.ccaa_cd || p.ccaa_id || raw.ccaa_cd || '',
            area: p.area_st || raw.area_st || ''
          }
        : {
            codatzbs: p.zbs_cd || p.codatzbs || raw.zbs_cd || raw.codatzbs || '',
            n_zbs: p.zbs_st || p.n_zbs || raw.zbs_st || raw.n_zbs || '',
            ccaa_cd: p.ccaa_cd || p.ccaa_id || raw.ccaa_cd || '',
            area: p.area_st || p.area || p.nombre_area_normalizado || '',
            id_zbs: p.id_zbs || raw.id_zbs || '',
            zbs_cd: p.zbs_cd || p.codatzbs || '',
            zbs_st: p.zbs_st || p.n_zbs || '',
            area_id: p.area_id || raw.area_id || '',
            area_cd: p.area_cd || raw.area_cd || '',
            area_st: p.area_st || p.area || '',
            valid_from: p.valid_from ?? raw.valid_from ?? '',
            valid_to: p.valid_to ?? raw.valid_to ?? '',
            version: p.version ?? raw.version ?? '',
            OGC_FID: p.OGC_FID ?? raw.OGC_FID ?? ''
          };

      return {
        type: 'Feature',
        geometry: f.geometry,
        properties: exportedProperties
      };
    });

    const exportData = {
      type: 'FeatureCollection',
      features: exportFeatures
    };

    const blob = new Blob([JSON.stringify(exportData)], { type: 'application/geo+json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `SNS_${grouping}_${year}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadShapefile = async () => {
    const rawFeatures = selectedShapesMap.size > 0
      ? Array.from(selectedShapesMap.values())
      : displayedGeoJSONRef.current?.features || [];

    if (!rawFeatures || rawFeatures.length === 0) return;

    setLoading(true);
    setProcessingMode('Generando paquete Shapefile (.shp, .shx, .dbf, .prj, .cpg)...');

    try {
      // 1. Asegurar disponibilidad de JSZip
      const getJSZip = async () => {
        if (window.JSZip) return window.JSZip;
        return new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
          s.onload = () => resolve(window.JSZip);
          s.onerror = () => reject(new Error('No se pudo cargar la librería JSZip.'));
          document.head.appendChild(s);
        });
      };

      const JSZipLib = await getJSZip();
      if (!JSZipLib) throw new Error('JSZip no disponible.');

      const isArea = Boolean(grouping === 'area');

      // 2. Definición de campos dBase IV (<= 10 caracteres)
      const fields = isArea ? [
        { name: 'area_st', type: 'C', length: 80 },
        { name: 'area_cd', type: 'C', length: 20 },
        { name: 'ccaa_cd', type: 'C', length: 10 },
        { name: 'total_zbs', type: 'N', length: 6 }
      ] : [
        { name: 'codatzbs', type: 'C', length: 20 },
        { name: 'n_zbs', type: 'C', length: 80 },
        { name: 'ccaa_cd', type: 'C', length: 10 },
        { name: 'area_st', type: 'C', length: 80 },
        { name: 'valid_from', type: 'C', length: 10 },
        { name: 'valid_to', type: 'C', length: 10 }
      ];

      // 3. Normalizar y parsear geometrías a Polygon ESRI (ShapeType 5)
      const parsedFeatures = [];
      let totalMinX = Infinity, totalMinY = Infinity, totalMaxX = -Infinity, totalMaxY = -Infinity;

      for (let i = 0; i < rawFeatures.length; i++) {
        const feat = rawFeatures[i];
        const polyGeom = extractPolygonalGeoJSON(feat.geometry);
        if (!polyGeom || !polyGeom.coordinates) continue;

        let rings = [];
        if (polyGeom.type === 'Polygon') {
          rings = polyGeom.coordinates;
        } else if (polyGeom.type === 'MultiPolygon') {
          for (const poly of polyGeom.coordinates) {
            for (const ring of poly) {
              rings.push(ring);
            }
          }
        }

        const validRings = [];
        let featMinX = Infinity, featMinY = Infinity, featMaxX = -Infinity, featMaxY = -Infinity;
        let totalPoints = 0;

        for (const ring of rings) {
          if (!Array.isArray(ring) || ring.length < 3) continue;
          const closedRing = [...ring];
          const first = closedRing[0];
          const last = closedRing[closedRing.length - 1];
          if (first[0] !== last[0] || first[1] !== last[1]) {
            closedRing.push([first[0], first[1]]);
          }

          if (closedRing.length >= 4) {
            validRings.push(closedRing);
            totalPoints += closedRing.length;

            for (const pt of closedRing) {
              const x = pt[0], y = pt[1];
              if (x < featMinX) featMinX = x;
              if (x > featMaxX) featMaxX = x;
              if (y < featMinY) featMinY = y;
              if (y > featMaxY) featMaxY = y;

              if (x < totalMinX) totalMinX = x;
              if (x > totalMaxX) totalMaxX = x;
              if (y < totalMinY) totalMinY = y;
              if (y > totalMaxY) totalMaxY = y;
            }
          }
        }

        if (validRings.length === 0) continue;

        const p = feat.allProperties || feat.properties || {};
        const contentBytes = 44 + (4 * validRings.length) + (16 * totalPoints);

        parsedFeatures.push({
          properties: isArea ? {
            area_st: String(p.area_st || p.displayName || '').substring(0, 80),
            area_cd: String(p.area_cd || '').substring(0, 20),
            ccaa_cd: String(p.ccaa_cd || '').substring(0, 10),
            total_zbs: Number(p.total_zbs || 1)
          } : {
            codatzbs: String(p.zbs_cd || p.codatzbs || '').substring(0, 20),
            n_zbs: String(p.zbs_st || p.n_zbs || p.displayName || '').substring(0, 80),
            ccaa_cd: String(p.ccaa_cd || '').substring(0, 10),
            area_st: String(p.area_st || p.area || '').substring(0, 80),
            valid_from: String(p.valid_from ?? '').substring(0, 10),
            valid_to: String(p.valid_to ?? '').substring(0, 10)
          },
          rings: validRings,
          totalPoints,
          contentBytes,
          minX: featMinX,
          minY: featMinY,
          maxX: featMaxX,
          maxY: featMaxY
        });
      }

      if (parsedFeatures.length === 0) {
        throw new Error('No se encontraron geometrías poligonales válidas para exportar.');
      }

      if (totalMinX === Infinity) {
        totalMinX = -18.2; totalMinY = 27.5; totalMaxX = 4.5; totalMaxY = 43.9;
      }

      // 4. Construcción binaria de .shp y .shx con offsets explícitos
      let totalContentBytes = 0;
      for (const f of parsedFeatures) {
        totalContentBytes += (8 + f.contentBytes);
      }

      const totalShpBytes = 100 + totalContentBytes;
      const totalShpWords = Math.floor(totalShpBytes / 2);

      const totalShxBytes = 100 + (8 * parsedFeatures.length);
      const totalShxWords = Math.floor(totalShxBytes / 2);

      const shpBuffer = new ArrayBuffer(totalShpBytes);
      const shpView = new DataView(shpBuffer);

      const shxBuffer = new ArrayBuffer(totalShxBytes);
      const shxView = new DataView(shxBuffer);

      // Cabecera .shp (100 bytes)
      shpView.setInt32(0, 9994, false); // File Code
      shpView.setInt32(24, totalShpWords, false); // File Length in 16-bit words
      shpView.setInt32(28, 1000, true); // Version
      shpView.setInt32(32, 5, true); // ShapeType 5 = Polygon
      shpView.setFloat64(36, totalMinX, true);
      shpView.setFloat64(44, totalMinY, true);
      shpView.setFloat64(52, totalMaxX, true);
      shpView.setFloat64(60, totalMaxY, true);

      // Cabecera .shx (100 bytes)
      shxView.setInt32(0, 9994, false);
      shxView.setInt32(24, totalShxWords, false);
      shxView.setInt32(28, 1000, true);
      shxView.setInt32(32, 5, true);
      shxView.setFloat64(36, totalMinX, true);
      shxView.setFloat64(44, totalMinY, true);
      shxView.setFloat64(52, totalMaxX, true);
      shxView.setFloat64(60, totalMaxY, true);

      // Variables de desplazamiento (offsets) declaradas explícitamente con let
      let currentShpOffset = 100;
      let currentShxOffset = 100;

      for (let i = 0; i < parsedFeatures.length; i++) {
        const feat = parsedFeatures[i];
        const recordNumber = i + 1;
        const contentWords = Math.floor(feat.contentBytes / 2);

        // Registro .shx (8 bytes)
        shxView.setInt32(currentShxOffset, Math.floor(currentShpOffset / 2), false); // Offset en palabras
        shxView.setInt32(currentShxOffset + 4, contentWords, false);
        currentShxOffset += 8;

        // Cabecera de registro .shp (8 bytes)
        shpView.setInt32(currentShpOffset, recordNumber, false);
        shpView.setInt32(currentShpOffset + 4, contentWords, false);
        currentShpOffset += 8;

        // Contenido de registro .shp
        shpView.setInt32(currentShpOffset, 5, true); // ShapeType 5
        shpView.setFloat64(currentShpOffset + 4, feat.minX, true);
        shpView.setFloat64(currentShpOffset + 12, feat.minY, true);
        shpView.setFloat64(currentShpOffset + 20, feat.maxX, true);
        shpView.setFloat64(currentShpOffset + 28, feat.maxY, true);

        shpView.setInt32(currentShpOffset + 36, feat.rings.length, true); // NumParts
        shpView.setInt32(currentShpOffset + 40, feat.totalPoints, true); // NumPoints

        const partsStartOffset = currentShpOffset + 44;
        const pointsStartOffset = partsStartOffset + (4 * feat.rings.length);

        let pointIndex = 0;
        for (let r = 0; r < feat.rings.length; r++) {
          shpView.setInt32(partsStartOffset + (r * 4), pointIndex, true);
          const ring = feat.rings[r];
          for (let pt = 0; pt < ring.length; pt++) {
            const ptByteOffset = pointsStartOffset + (pointIndex * 16);
            shpView.setFloat64(ptByteOffset, ring[pt][0], true); // X
            shpView.setFloat64(ptByteOffset + 8, ring[pt][1], true); // Y
            pointIndex++;
          }
        }

        currentShpOffset += feat.contentBytes;
      }

      // 5. Construcción binaria de la tabla de atributos .dbf
      let recordLength = 1; // 1 byte delete flag (0x20)
      for (const f of fields) {
        recordLength += f.length;
      }

      const headerLength = 32 + (fields.length * 32) + 1;
      const totalDbfBytes = headerLength + (parsedFeatures.length * recordLength) + 1;

      const dbfBuffer = new ArrayBuffer(totalDbfBytes);
      const dbfView = new DataView(dbfBuffer);
      const dbfBytes = new Uint8Array(dbfBuffer);

      const now = new Date();
      dbfView.setUint8(0, 0x03); // dBase III
      dbfView.setUint8(1, now.getFullYear() - 1900);
      dbfView.setUint8(2, now.getMonth() + 1);
      dbfView.setUint8(3, now.getDate());
      dbfView.setUint32(4, parsedFeatures.length, true);
      dbfView.setUint16(8, headerLength, true);
      dbfView.setUint16(10, recordLength, true);

      let fieldDescriptorOffset = 32;
      const textEncoder = new TextEncoder();

      for (const f of fields) {
        const nameBytes = textEncoder.encode(f.name);
        for (let n = 0; n < 11; n++) {
          dbfView.setUint8(fieldDescriptorOffset + n, n < nameBytes.length ? nameBytes[n] : 0);
        }
        dbfView.setUint8(fieldDescriptorOffset + 11, f.type.charCodeAt(0));
        dbfView.setUint8(fieldDescriptorOffset + 16, f.length);
        fieldDescriptorOffset += 32;
      }

      dbfView.setUint8(fieldDescriptorOffset, 0x0D); // Terminador de cabecera

      let rowOffset = headerLength;
      for (let i = 0; i < parsedFeatures.length; i++) {
        const props = parsedFeatures[i].properties;
        dbfBytes[rowOffset] = 0x20; // 0x20 = registro activo (no borrado)
        let colOffset = rowOffset + 1;

        for (const f of fields) {
          let rawVal = props[f.name];
          if (rawVal === undefined || rawVal === null) rawVal = '';
          const strVal = String(rawVal);
          const valBytes = textEncoder.encode(strVal);

          if (f.type === 'N') {
            const padLen = Math.max(0, f.length - valBytes.length);
            for (let k = 0; k < padLen; k++) {
              dbfBytes[colOffset + k] = 0x20;
            }
            for (let k = 0; k < Math.min(valBytes.length, f.length); k++) {
              dbfBytes[colOffset + padLen + k] = valBytes[k];
            }
          } else {
            for (let k = 0; k < f.length; k++) {
              dbfBytes[colOffset + k] = k < valBytes.length ? valBytes[k] : 0x20;
            }
          }
          colOffset += f.length;
        }
        rowOffset += recordLength;
      }

      dbfBytes[totalDbfBytes - 1] = 0x1A; // Terminador EOF de dBase

      // 6. Empaquetar en .zip con JSZip
      const layerName = isArea ? `SNS_Areas_${year}` : `SNS_ZBS_${year}`;
      const suffix = selectedShapesMap.size > 0 ? '_seleccion' : '';
      const zip = new JSZipLib();

      zip.file(`${layerName}.shp`, shpBuffer);
      zip.file(`${layerName}.shx`, shxBuffer);
      zip.file(`${layerName}.dbf`, dbfBuffer);
      zip.file(`${layerName}.prj`, ETRS89_PRJ);
      zip.file(`${layerName}.cpg`, 'UTF-8\r\n');

      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });

      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${layerName}${suffix}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Error generando paquete Shapefile:', err);
    } finally {
      setLoading(false);
      setProcessingMode('');
    }
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isMobile ? 'column' : 'row',
        width: '100%',
        height: '100%',
        flex: 1,
        minHeight: 0,
        padding: isMobile ? '0.45rem' : '0.85rem',
        gap: isMobile ? '0.45rem' : '0.85rem',
        boxSizing: 'border-box',
        overflow: 'hidden',
        backgroundColor: ASPIRE_THEME.bg,
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
      }}
    >
      {/* Selector de pestañas móvil */}
      {isMobile && (
        <nav
          role="tablist"
          style={{
            display: 'flex',
            width: '100%',
            background: '#ffffff',
            borderRadius: '10px',
            padding: '3px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            border: `1px solid ${ASPIRE_THEME.border}`,
            flexShrink: 0
          }}
        >
          <button
            role="tab"
            aria-selected={mobileTab === 'panel'}
            onClick={() => setMobileTab('panel')}
            style={{
              flex: 1,
              padding: '0.48rem 0.5rem',
              borderRadius: '7px',
              border: 'none',
              backgroundColor: mobileTab === 'panel' ? ASPIRE_THEME.blue : 'transparent',
              color: mobileTab === 'panel' ? '#ffffff' : ASPIRE_THEME.gray,
              fontWeight: '700',
              fontSize: '0.76rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px'
            }}
          >
            <span>📊</span>
            <span>Filtros y Tabla ({selectedShapesMap.size} sel.)</span>
          </button>
          <button
            role="tab"
            aria-selected={mobileTab === 'mapa'}
            onClick={() => setMobileTab('mapa')}
            style={{
              flex: 1,
              padding: '0.48rem 0.5rem',
              borderRadius: '7px',
              border: 'none',
              backgroundColor: mobileTab === 'mapa' ? ASPIRE_THEME.blue : 'transparent',
              color: mobileTab === 'mapa' ? '#ffffff' : ASPIRE_THEME.gray,
              fontWeight: '700',
              fontSize: '0.76rem',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px'
            }}
          >
            <span>🗺️</span>
            <span>Visor Cartográfico</span>
          </button>
        </nav>
      )}

      {/* PANEL LATERAL DE CONTROLES */}
      <aside
        style={{
          display: isMobile && mobileTab !== 'panel' ? 'none' : 'flex',
          flexDirection: 'column',
          gap: '0.75rem',
          width: isMobile ? '100%' : 'clamp(340px, 30vw, 460px)',
          flexShrink: 0,
          height: isMobile ? 'calc(100% - 46px)' : '100%',
          minHeight: 0,
          boxSizing: 'border-box',
          overflowY: 'auto',
          paddingRight: isMobile ? '0' : '4px'
        }}
      >
        {/* BLOQUE 1: CONFIGURACIÓN TERRITORIAL Y FILTROS DUCKDB */}
        <div
          style={{
            background: '#ffffff',
            borderRadius: '12px',
            padding: isMobile ? '0.85rem' : '1.1rem',
            boxShadow: '0 2px 6px rgba(0,0,0,0.04)',
            border: `1px solid ${ASPIRE_THEME.border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.65rem',
            flexShrink: 0
          }}
        >
          {/* Cabecera */}
          <div style={{ borderBottom: `1.5px solid #f1f5f9`, paddingBottom: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
              <span
                style={{
                  fontSize: '0.66rem',
                  backgroundColor: 'rgba(0, 140, 150, 0.12)',
                  color: ASPIRE_THEME.teal,
                  padding: '2px 7px',
                  borderRadius: '4px',
                  fontWeight: '700'
                }}
              >
                {displayedGeoJSONRef.current.features.length} zonas vigentes
              </span>
            </div>
          </div>

          {/* Selector de Año SCD-2 y Nivel */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: '700', color: ASPIRE_THEME.gray, marginBottom: '3px' }}>
                Año de Vigencia
              </label>
              <select
                value={year}
                onChange={(e) => setYear(e.target.value)}
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '0.4rem 0.5rem',
                  borderRadius: '6px',
                  border: `1px solid ${ASPIRE_THEME.border}`,
                  fontSize: '0.76rem',
                  outline: 'none',
                  backgroundColor: '#ffffff'
                }}
              >
                {availableYears.map(y => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: '700', color: ASPIRE_THEME.gray, marginBottom: '3px' }}>
                Nivel territorial
              </label>
              <select
                value={grouping}
                onChange={(e) => setGrouping(e.target.value)}
                disabled={loading}
                style={{
                  width: '100%',
                  padding: '0.4rem 0.5rem',
                  borderRadius: '6px',
                  border: `1px solid ${ASPIRE_THEME.blue}`,
                  fontSize: '0.76rem',
                  outline: 'none',
                  backgroundColor: 'rgba(60, 100, 163, 0.08)',
                  color: ASPIRE_THEME.blue,
                  fontWeight: '700'
                }}
              >
                <option value="zbs">ZBS (Zonas Básicas)</option>
                <option value="area">Áreas Fusionadas</option>
              </select>
            </div>
          </div>

          {/* Selector de Comunidades Autónomas (ccaa_cd) */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '3px' }}>
              <label style={{ fontSize: '0.7rem', fontWeight: '700', color: ASPIRE_THEME.gray }}>
                Comunidades (ccaa_cd) ({selectedCCAA.length}/{COMUNIDADES.length})
              </label>
              <div style={{ display: 'flex', gap: '4px' }}>
                <button
                  onClick={handleSelectAll}
                  disabled={loading}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '0.66rem',
                    color: ASPIRE_THEME.blue,
                    cursor: 'pointer',
                    fontWeight: '600',
                    padding: 0
                  }}
                >
                  Todas
                </button>
                <span style={{ fontSize: '0.66rem', color: '#cbd5e1' }}>•</span>
                <button
                  onClick={handleClearSelection}
                  disabled={loading}
                  style={{
                    background: 'none',
                    border: 'none',
                    fontSize: '0.66rem',
                    color: ASPIRE_THEME.gray,
                    cursor: 'pointer',
                    fontWeight: '600',
                    padding: 0
                  }}
                >
                  Limpiar
                </button>
              </div>
            </div>

            <input
              type="text"
              placeholder="Filtrar CCAA por código o nombre..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '0.35rem 0.55rem',
                borderRadius: '6px',
                border: `1px solid ${ASPIRE_THEME.border}`,
                fontSize: '0.72rem',
                outline: 'none',
                marginBottom: '4px'
              }}
            />

            <div
              style={{
                height: '200px',
                overflowY: 'auto',
                border: `1px solid #f1f5f9`,
                borderRadius: '7px',
                padding: '3px',
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
                background: '#ffffff'
              }}
            >
              {filteredCCAA.map((c) => {
                const isSelected = selectedCCAA.includes(c.id);
                return (
                  <label
                    key={c.id}
                    onClick={() => toggleCCAA(c.id)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px',
                      padding: '3px 6px',
                      borderRadius: '5px',
                      backgroundColor: isSelected ? 'rgba(60, 100, 163, 0.08)' : 'transparent',
                      cursor: 'pointer',
                      fontSize: '0.72rem',
                      color: isSelected ? ASPIRE_THEME.blue : ASPIRE_THEME.gray,
                      fontWeight: isSelected ? '700' : '400'
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      readOnly
                      style={{ cursor: 'pointer', accentColor: ASPIRE_THEME.blue }}
                    />
                    <span
                      style={{
                        width: '7px',
                        height: '7px',
                        borderRadius: '50%',
                        backgroundColor: CCAA_COLORS[c.id] || ASPIRE_THEME.blue,
                        flexShrink: 0
                      }}
                    />
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.nombre} <span style={{ fontSize: '0.64rem', color: ASPIRE_THEME.textSecondary }}>({c.id})</span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Botones de Exportación Cartográfica */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', paddingTop: '0.4rem', borderTop: `1px solid #f1f5f9` }}>
            <button
              onClick={downloadGeoJSON}
              disabled={loading || displayedGeoJSONRef.current.features.length === 0}
              style={{
                backgroundColor: ASPIRE_THEME.black,
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '0.42rem',
                fontSize: '0.68rem',
                fontWeight: '600',
                cursor: 'pointer',
                opacity: loading || displayedGeoJSONRef.current.features.length === 0 ? 0.5 : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px'
              }}
            >
              <span>{'{ }'}</span> GeoJSON
            </button>
            <button
              onClick={downloadShapefile}
              disabled={loading || displayedGeoJSONRef.current.features.length === 0}
              style={{
                backgroundColor: ASPIRE_THEME.teal,
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '0.42rem',
                fontSize: '0.68rem',
                fontWeight: '600',
                cursor: 'pointer',
                opacity: loading || displayedGeoJSONRef.current.features.length === 0 ? 0.5 : 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '4px'
              }}
            >
              <span>🗺️</span> Shapefile
            </button>
          </div>
        </div>

        {/* BLOQUE 2: TABLA DE ATRIBUTOS MATRICIAL DE LAS SHAPES */}
        <div
          style={{
            background: '#ffffff',
            borderRadius: '12px',
            padding: isMobile ? '0.85rem' : '1.1rem',
            boxShadow: '0 2px 6px rgba(0,0,0,0.04)',
            border: `1px solid ${ASPIRE_THEME.border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.6rem',
            flexShrink: 0
          }}
        >
          {/* Cabecera de la tabla */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: `1.5px solid #f1f5f9`, paddingBottom: '0.4rem', flexWrap: 'wrap', gap: '4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '0.95rem' }}>📊</span>
              <h3 style={{ margin: 0, fontSize: '0.86rem', color: ASPIRE_THEME.black, fontWeight: '700' }}>
                Información ({selectedShapesMap.size})
              </h3>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <button
                onClick={() => setIsTableModalOpen(true)}
                title="Expandir tabla completa de atributos a pantalla completa"
                style={{
                  background: 'rgba(60, 100, 163, 0.08)',
                  border: `1px solid rgba(60, 100, 163, 0.3)`,
                  color: ASPIRE_THEME.blue,
                  borderRadius: '5px',
                  padding: '2px 7px',
                  fontSize: '0.66rem',
                  fontWeight: '700',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '3px'
                }}
              >
                <span>⛶</span>
                <span>Expandir</span>
              </button>

              <button
                onClick={exportTableToCSV}
                disabled={targetShapesList.length === 0}
                title="Descargar tabla en formato CSV con todas las propiedades"
                style={{
                  background: 'rgba(0, 140, 150, 0.08)',
                  border: `1px solid rgba(0, 140, 150, 0.3)`,
                  color: ASPIRE_THEME.teal,
                  borderRadius: '5px',
                  padding: '2px 7px',
                  fontSize: '0.66rem',
                  fontWeight: '700',
                  cursor: targetShapesList.length === 0 ? 'not-allowed' : 'pointer',
                  opacity: targetShapesList.length === 0 ? 0.5 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '3px'
                }}
              >
                <span>📥</span>
                <span>CSV</span>
              </button>
            </div>
          </div>

          {/* Controles de selección rápida */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '6px', fontSize: '0.7rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer', color: ASPIRE_THEME.gray, fontWeight: '600' }}>
              <input
                type="checkbox"
                checked={multiSelectMode}
                onChange={(e) => setMultiSelectMode(e.target.checked)}
                style={{ cursor: 'pointer', accentColor: ASPIRE_THEME.blue }}
              />
              <span>Multiselección</span>
            </label>

            <div style={{ display: 'flex', gap: '4px' }}>
              <button
                onClick={handleSelectAllLoadedShapes}
                disabled={loading || displayedGeoJSONRef.current.features.length === 0}
                style={{
                  background: 'none',
                  border: 'none',
                  color: ASPIRE_THEME.blue,
                  fontSize: '0.66rem',
                  fontWeight: '700',
                  cursor: 'pointer',
                  padding: 0
                }}
              >
                Sel. todas ({displayedGeoJSONRef.current.features.length})
              </button>
              <span style={{ color: '#cbd5e1' }}>•</span>
              <button
                onClick={handleClearSelectedShapes}
                disabled={selectedShapesMap.size === 0}
                style={{
                  background: 'none',
                  border: 'none',
                  color: ASPIRE_THEME.gray,
                  fontSize: '0.66rem',
                  fontWeight: '600',
                  cursor: selectedShapesMap.size === 0 ? 'default' : 'pointer',
                  padding: 0,
                  opacity: selectedShapesMap.size === 0 ? 0.4 : 1
                }}
              >
                Limpiar
              </button>
            </div>
          </div>

          {/* Filtro dentro de la tabla */}
          <div>
            <input
              type="text"
              placeholder="Buscar en shapes seleccionadas (zbs_cd, zbs_st, area_st)..."
              value={tableSearchFilter}
              onChange={(e) => setTableSearchFilter(e.target.value)}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '0.35rem 0.55rem',
                borderRadius: '6px',
                border: `1px solid ${ASPIRE_THEME.border}`,
                fontSize: '0.7rem',
                outline: 'none',
                backgroundColor: '#ffffff'
              }}
            />
          </div>

          {/* TABLA MATRICIAL */}
          {selectedShapesMap.size > 0 ? (
            <div
              style={{
                maxHeight: '280px',
                overflow: 'auto',
                border: `1px solid ${ASPIRE_THEME.border}`,
                borderRadius: '7px',
                boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.03)'
              }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.68rem', textAlign: 'left', minWidth: '480px' }}>
                <thead>
                  <tr style={{ backgroundColor: ASPIRE_THEME.tableHeader, position: 'sticky', top: 0, zIndex: 2 }}>
                    <th style={{ padding: '6px 8px', borderBottom: `1.5px solid ${ASPIRE_THEME.border}`, color: ASPIRE_THEME.gray, fontWeight: '700', width: '70px', whiteSpace: 'nowrap' }}>
                      Acciones
                    </th>
                    <th
                      onClick={() => handleHeaderSort('displayName')}
                      style={{ padding: '6px 8px', borderBottom: `1.5px solid ${ASPIRE_THEME.border}`, color: ASPIRE_THEME.blue, fontWeight: '700', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                      Geometría {sortConfig.key === 'displayName' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '↕'}
                    </th>
                    <th
                      onClick={() => handleHeaderSort('ccaaNombre')}
                      style={{ padding: '6px 8px', borderBottom: `1.5px solid ${ASPIRE_THEME.border}`, color: ASPIRE_THEME.gray, fontWeight: '700', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                      CCAA {sortConfig.key === 'ccaaNombre' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '↕'}
                    </th>
                    {allPropertyKeys
                      .filter(k => !['displayName', 'ccaaNombre'].includes(k))
                      .map(key => (
                        <th
                          key={key}
                          onClick={() => handleHeaderSort(key)}
                          style={{
                            padding: '6px 8px',
                            borderBottom: `1.5px solid ${ASPIRE_THEME.border}`,
                            color: ASPIRE_THEME.gray,
                            fontWeight: '700',
                            fontFamily: 'monospace',
                            cursor: 'pointer',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {key} {sortConfig.key === key ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '↕'}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredAndSortedShapes.length === 0 ? (
                    <tr>
                      <td colSpan={allPropertyKeys.length + 1} style={{ padding: '12px', textAlign: 'center', color: '#94a3b8' }}>
                        No hay shapes coincidentes con el filtro
                      </td>
                    </tr>
                  ) : (
                    filteredAndSortedShapes.map((shape, idx) => {
                      const isEven = idx % 2 === 0;
                      const props = shape.allProperties || shape.properties || {};

                      return (
                        <tr
                          key={shape.feature_id || idx}
                          onClick={() => handleFocusShapeOnMap(shape)}
                          style={{
                            backgroundColor: isEven ? ASPIRE_THEME.tableRowEven : ASPIRE_THEME.tableRowOdd,
                            cursor: 'pointer',
                            transition: 'background-color 0.1s'
                          }}
                        >
                          <td style={{ padding: '4px 8px', borderBottom: `1px solid #f1f5f9`, whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'flex', gap: '4px' }}>
                              <button
                                onClick={(e) => handleFocusShapeOnMap(shape, e)}
                                title="Centrar en el mapa"
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  padding: '1px 3px',
                                  fontSize: '0.7rem'
                                }}
                              >
                                🔍
                              </button>
                              <button
                                onClick={(e) => handleRemoveSingleShape(shape.feature_id, e)}
                                title="Quitar de selección"
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  cursor: 'pointer',
                                  padding: '1px 3px',
                                  color: '#ef4444',
                                  fontWeight: 'bold',
                                  fontSize: '0.7rem'
                                }}
                              >
                                ×
                              </button>
                            </div>
                          </td>

                          <td style={{ padding: '4px 8px', borderBottom: `1px solid #f1f5f9`, fontWeight: '700', color: ASPIRE_THEME.blue, whiteSpace: 'nowrap' }}>
                            {shape.displayName}
                          </td>

                          <td style={{ padding: '4px 8px', borderBottom: `1px solid #f1f5f9`, color: ASPIRE_THEME.gray, whiteSpace: 'nowrap' }}>
                            {shape.ccaaNombre}
                          </td>

                          {allPropertyKeys
                            .filter(k => !['displayName', 'ccaaNombre'].includes(k))
                            .map(key => {
                              const val = props[key] ?? shape[key];
                              const strVal = typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val ?? '-');
                              return (
                                <td
                                  key={key}
                                  style={{
                                    padding: '4px 8px',
                                    borderBottom: `1px solid #f1f5f9`,
                                    color: ASPIRE_THEME.black,
                                    whiteSpace: 'nowrap',
                                    maxWidth: '180px',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                  }}
                                  title={`${key}: ${strVal}`}
                                >
                                  {strVal}
                                </td>
                              );
                            })}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          ) : (
            <div
              style={{
                textAlign: 'center',
                color: ASPIRE_THEME.gray,
                padding: '1.25rem 0.75rem',
                border: '1.5px dashed #cbd5e1',
                borderRadius: '8px',
                fontSize: '0.72rem',
                lineHeight: '1.4'
              }}
            >
        
              <strong>Haz clic en cualquier zona o activa "Multiselección"</strong>
              <div style={{ color: '#94a3b8', marginTop: '2px', fontSize: '0.68rem' }}>
                Se añadirán las geometrías a esta tabla con todos sus atributos.
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* LIENZO MAPLIBRE GL A PANTALLA COMPLETA */}
      <main
        style={{
          display: isMobile && mobileTab !== 'mapa' ? 'none' : 'block',
          flex: 1,
          backgroundColor: '#ffffff',
          borderRadius: '12px',
          boxShadow: '0 2px 6px rgba(0,0,0,0.06)',
          overflow: 'hidden',
          position: 'relative',
          border: `1px solid ${ASPIRE_THEME.border}`,
          height: isMobile ? 'calc(100% - 46px)' : '100%',
          minHeight: 0
        }}
      >
        {loading && (
          <div
            style={{
              position: 'absolute',
              top: '10px',
              right: isMobile ? '10px' : '55px',
              zIndex: 20,
              background: 'rgba(255, 255, 255, 0.96)',
              backdropFilter: 'blur(4px)',
              border: `1px solid ${ASPIRE_THEME.lightBlue}`,
              borderRadius: '7px',
              padding: '4px 10px',
              fontSize: '0.7rem',
              color: ASPIRE_THEME.black,
              boxShadow: '0 2px 5px rgba(0,0,0,0.08)',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              maxWidth: 'calc(100vw - 40px)'
            }}
          >
            <span style={{ animation: 'spin 1.2s linear infinite', display: 'inline-block' }}>🦆</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {processingMode}
            </span>
          </div>
        )}

        {/* Indicador de vigencia y shapes seleccionadas */}
        <div
          style={{
            position: 'absolute',
            bottom: '12px',
            left: '12px',
            zIndex: 20,
            background: 'rgba(255, 255, 255, 0.96)',
            backdropFilter: 'blur(4px)',
            border: `1.5px solid ${ASPIRE_THEME.blue}`,
            borderRadius: '8px',
            padding: '5px 10px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '0.72rem'
          }}
        >
          <span style={{ fontWeight: '700', color: ASPIRE_THEME.blue }}>
            Año {year} • {displayedGeoJSONRef.current.features.length} zonas vigentes
          </span>
          {selectedShapesMap.size > 0 && (
            <>
              <span style={{ color: ASPIRE_THEME.borderDark }}>|</span>
              <span style={{ fontWeight: '600', color: ASPIRE_THEME.teal }}>
                {selectedShapesMap.size} seleccionadas
              </span>
              <button
                onClick={() => setIsTableModalOpen(true)}
                style={{
                  background: ASPIRE_THEME.blue,
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '5px',
                  padding: '2px 7px',
                  fontSize: '0.68rem',
                  fontWeight: '700',
                  cursor: 'pointer'
                }}
              >
                Ver Tabla
              </button>
            </>
          )}
        </div>

        <div ref={mapContainer} style={{ width: '100%', height: '100%' }} />
      </main>

      {/* MODAL EXPANDIDO DE LA TABLA MATRICIAL */}
      {isTableModalOpen && (
        <div
          onClick={() => setIsTableModalOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(29, 29, 27, 0.65)',
            backdropFilter: 'blur(4px)',
            zIndex: 9999,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: isMobile ? '0.4rem' : '1.25rem',
            boxSizing: 'border-box'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: '#ffffff',
              borderRadius: '14px',
              width: '100%',
              maxWidth: '1280px',
              height: '92dvh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 20px 45px rgba(0,0,0,0.28)',
              border: `1px solid ${ASPIRE_THEME.border}`,
              overflow: 'hidden'
            }}
          >
            {/* Cabecera del modal */}
            <div
              style={{
                padding: '0.85rem 1.25rem',
                borderBottom: `1px solid ${ASPIRE_THEME.border}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                background: '#f8fafc',
                flexWrap: 'wrap',
                gap: '8px'
              }}
            >
              <div>
                <h3 style={{ margin: 0, fontSize: '1.05rem', color: ASPIRE_THEME.black, fontWeight: '700' }}>
                  Tabla: Zonas Básicas de Salud ({filteredAndSortedShapes.length} registros)
                </h3>
                <span style={{ fontSize: '0.72rem', color: ASPIRE_THEME.lightBlue }}>
                  Vigencia activa para el año {year} • {allPropertyKeys.length} columnas • Nivel: {grouping === 'zbs' ? 'ZBS' : 'Áreas'}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <div style={{ display: 'flex', background: '#e2e8f0', borderRadius: '6px', padding: '2px' }}>
                  <button
                    onClick={() => setTableMode('selected')}
                    style={{
                      padding: '3px 8px',
                      borderRadius: '5px',
                      border: 'none',
                      fontSize: '0.7rem',
                      fontWeight: '700',
                      cursor: 'pointer',
                      backgroundColor: tableMode === 'selected' ? '#ffffff' : 'transparent',
                      color: tableMode === 'selected' ? ASPIRE_THEME.blue : ASPIRE_THEME.gray
                    }}
                  >
                    Seleccionadas ({selectedShapesMap.size})
                  </button>
                  <button
                    onClick={() => setTableMode('all')}
                    style={{
                      padding: '3px 8px',
                      borderRadius: '5px',
                      border: 'none',
                      fontSize: '0.7rem',
                      fontWeight: '700',
                      cursor: 'pointer',
                      backgroundColor: tableMode === 'all' ? '#ffffff' : 'transparent',
                      color: tableMode === 'all' ? ASPIRE_THEME.blue : ASPIRE_THEME.gray
                    }}
                  >
                    Todas Vigentes ({displayedGeoJSONRef.current.features.length})
                  </button>
                </div>

                <button
                  onClick={exportTableToCSV}
                  disabled={targetShapesList.length === 0}
                  style={{
                    backgroundColor: ASPIRE_THEME.teal,
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '6px',
                    padding: '0.38rem 0.85rem',
                    fontSize: '0.72rem',
                    fontWeight: '700',
                    cursor: targetShapesList.length === 0 ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                >
                  <span>📥</span> Exportar CSV
                </button>

                <button
                  onClick={() => setIsTableModalOpen(false)}
                  style={{
                    background: '#ffffff',
                    border: `1px solid ${ASPIRE_THEME.border}`,
                    borderRadius: '6px',
                    width: '30px',
                    height: '30px',
                    cursor: 'pointer',
                    fontSize: '1.1rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: ASPIRE_THEME.gray
                  }}
                >
                  ×
                </button>
              </div>
            </div>

            {/* Barra de filtrado en el modal */}
            <div style={{ padding: '0.65rem 1.25rem', borderBottom: `1px solid #f1f5f9`, display: 'flex', gap: '10px', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="Filtrar por cualquier columna (zbs_cd, zbs_st, valid_from, valid_to, area_st)..."
                value={tableSearchFilter}
                onChange={(e) => setTableSearchFilter(e.target.value)}
                style={{
                  flex: 1,
                  boxSizing: 'border-box',
                  padding: '0.45rem 0.75rem',
                  borderRadius: '6px',
                  border: `1px solid ${ASPIRE_THEME.border}`,
                  fontSize: '0.76rem',
                  outline: 'none'
                }}
              />
              <span style={{ fontSize: '0.7rem', color: ASPIRE_THEME.gray, whiteSpace: 'nowrap' }}>
                Mostrando {filteredAndSortedShapes.length} de {targetShapesList.length}
              </span>
            </div>

            {/* Rejilla de datos con scroll horizontal y vertical */}
            <div style={{ flex: 1, overflow: 'auto', padding: '0 1.25rem' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.74rem', textAlign: 'left', margin: '0.75rem 0' }}>
                <thead>
                  <tr style={{ backgroundColor: ASPIRE_THEME.tableHeader, position: 'sticky', top: 0, zIndex: 3 }}>
                    <th style={{ padding: '8px 10px', borderBottom: `2px solid ${ASPIRE_THEME.border}`, color: ASPIRE_THEME.gray, fontWeight: '700', width: '70px', whiteSpace: 'nowrap' }}>
                      Acción
                    </th>
                    <th
                      onClick={() => handleHeaderSort('displayName')}
                      style={{ padding: '8px 10px', borderBottom: `2px solid ${ASPIRE_THEME.border}`, color: ASPIRE_THEME.blue, fontWeight: '700', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                      Identificador / Geometría {sortConfig.key === 'displayName' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '↕'}
                    </th>
                    <th
                      onClick={() => handleHeaderSort('ccaaNombre')}
                      style={{ padding: '8px 10px', borderBottom: `2px solid ${ASPIRE_THEME.border}`, color: ASPIRE_THEME.gray, fontWeight: '700', cursor: 'pointer', whiteSpace: 'nowrap' }}
                    >
                      CCAA {sortConfig.key === 'ccaaNombre' ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '↕'}
                    </th>
                    {allPropertyKeys
                      .filter(k => !['displayName', 'ccaaNombre'].includes(k))
                      .map(key => (
                        <th
                          key={key}
                          onClick={() => handleHeaderSort(key)}
                          style={{
                            padding: '8px 10px',
                            borderBottom: `2px solid ${ASPIRE_THEME.border}`,
                            color: ASPIRE_THEME.gray,
                            fontWeight: '700',
                            fontFamily: 'monospace',
                            cursor: 'pointer',
                            whiteSpace: 'nowrap'
                          }}
                        >
                          {key} {sortConfig.key === key ? (sortConfig.direction === 'asc' ? '▲' : '▼') : '↕'}
                        </th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredAndSortedShapes.length === 0 ? (
                    <tr>
                      <td colSpan={allPropertyKeys.length + 1} style={{ padding: '20px', textAlign: 'center', color: '#94a3b8' }}>
                        No hay registros vigentes que coincidan con los filtros.
                      </td>
                    </tr>
                  ) : (
                    filteredAndSortedShapes.map((shape, idx) => {
                      const isEven = idx % 2 === 0;
                      const props = shape.allProperties || shape.properties || {};
                      const isSelected = selectedShapesMap.has(shape.feature_id);

                      return (
                        <tr
                          key={shape.feature_id || idx}
                          onClick={() => handleFocusShapeOnMap(shape)}
                          style={{
                            backgroundColor: isSelected
                              ? 'rgba(60, 100, 163, 0.08)'
                              : isEven ? '#ffffff' : '#f8fafc',
                            cursor: 'pointer',
                            transition: 'background-color 0.1s'
                          }}
                        >
                          <td style={{ padding: '6px 10px', borderBottom: `1px solid #f1f5f9`, whiteSpace: 'nowrap' }}>
                            <div style={{ display: 'flex', gap: '6px' }}>
                              <button
                                onClick={(e) => {
                                  handleFocusShapeOnMap(shape, e);
                                  setIsTableModalOpen(false);
                                }}
                                title="Centrar y ver en el mapa"
                                style={{
                                  background: ASPIRE_THEME.blue,
                                  color: '#ffffff',
                                  border: 'none',
                                  borderRadius: '4px',
                                  padding: '2px 5px',
                                  fontSize: '0.68rem',
                                  cursor: 'pointer'
                                }}
                              >
                                Ver
                              </button>
                              <button
                                onClick={(e) => handleRemoveSingleShape(shape.feature_id, e)}
                                title="Quitar shape de la selección"
                                style={{
                                  background: '#fee2e2',
                                  color: '#dc2626',
                                  border: 'none',
                                  borderRadius: '4px',
                                  padding: '2px 5px',
                                  fontSize: '0.68rem',
                                  fontWeight: 'bold',
                                  cursor: 'pointer'
                                }}
                              >
                                ×
                              </button>
                            </div>
                          </td>

                          <td style={{ padding: '6px 10px', borderBottom: `1px solid #f1f5f9`, fontWeight: '700', color: ASPIRE_THEME.blue, whiteSpace: 'nowrap' }}>
                            {shape.displayName}
                          </td>

                          <td style={{ padding: '6px 10px', borderBottom: `1px solid #f1f5f9`, color: ASPIRE_THEME.gray, whiteSpace: 'nowrap' }}>
                            {shape.ccaaNombre}
                          </td>

                          {allPropertyKeys
                            .filter(k => !['displayName', 'ccaaNombre'].includes(k))
                            .map(key => {
                              const val = props[key] ?? shape[key];
                              const strVal = typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val ?? '-');
                              return (
                                <td
                                  key={key}
                                  style={{
                                    padding: '6px 10px',
                                    borderBottom: `1px solid #f1f5f9`,
                                    color: ASPIRE_THEME.black,
                                    whiteSpace: 'nowrap',
                                    maxWidth: '260px',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                  }}
                                  title={`${key}: ${strVal}`}
                                >
                                  {strVal}
                                </td>
                              );
                            })}
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Pie del modal */}
            <div style={{ padding: '0.65rem 1.25rem', borderTop: `1px solid ${ASPIRE_THEME.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#f8fafc' }}>
              <span style={{ fontSize: '0.72rem', color: ASPIRE_THEME.gray }}>
                Haz clic en cualquier fila o pulsa <strong>"Ver"</strong> para enfocar la zona en el mapa.
              </span>
              <button
                onClick={() => setIsTableModalOpen(false)}
                style={{
                  backgroundColor: ASPIRE_THEME.blue,
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '0.45rem 1.1rem',
                  fontSize: '0.76rem',
                  fontWeight: '700',
                  cursor: 'pointer'
                }}
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}