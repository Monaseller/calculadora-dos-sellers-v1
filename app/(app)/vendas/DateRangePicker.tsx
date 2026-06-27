"use client";
import { useState } from "react";

interface Props {
  from: string; // YYYY-MM-DD
  to:   string;
  onChange: (from: string, to: string) => void;
}

const MESES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const DIAS  = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];

function toISO(d: Date) {
  return d.toISOString().split("T")[0];
}

function parseISO(s: string) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function hojeISO() {
  const now = new Date();
  const br  = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return br.toISOString().split("T")[0];
}

const PRESETS = [
  { label: "Hoje",        get: () => { const h = hojeISO(); return [h, h]; } },
  { label: "Ontem",       get: () => { const d = new Date(parseISO(hojeISO())); d.setDate(d.getDate()-1); const s = toISO(d); return [s,s]; } },
  { label: "Esta semana", get: () => {
    const hoje = parseISO(hojeISO());
    const seg  = new Date(hoje);
    const day  = hoje.getDay(); // 0=dom, 1=seg, ..., 6=sáb
    // Dias desde a última segunda-feira
    const diasAteSeg = day === 0 ? 6 : day === 1 ? 0 : day - 1;
    seg.setDate(hoje.getDate() - diasAteSeg);
    return [toISO(seg), hojeISO()];
  }},
  { label: "Últimos 7 dias", get: () => {
    const d = new Date(parseISO(hojeISO()));
    d.setDate(d.getDate() - 7); // ML conta hoje + 7 dias anteriores = 8 dias
    return [toISO(d), hojeISO()];
  }},
  { label: "Este mês",    get: () => {
    const hoje = parseISO(hojeISO());
    const ini  = new Date(hoje.getFullYear(), hoje.getMonth(), 1);
    return [toISO(ini), hojeISO()];
  }},
  { label: "Mês passado", get: () => {
    const hoje = parseISO(hojeISO());
    const ini  = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    const fim  = new Date(hoje.getFullYear(), hoje.getMonth(), 0);
    return [toISO(ini), toISO(fim)];
  }},
  { label: "Este ano",    get: () => {
    const hoje = parseISO(hojeISO());
    return [`${hoje.getFullYear()}-01-01`, hojeISO()];
  }},
];

export default function DateRangePicker({ from, to, onChange }: Props) {
  const [open,         setOpen]         = useState(false);
  const [selecting,    setSelecting]    = useState<"start" | "end">("start");
  const [tempFrom,     setTempFrom]     = useState(from);
  const [tempTo,       setTempTo]       = useState(to);
  const [hover,        setHover]        = useState<string | null>(null);
  const [activePreset, setActivePreset] = useState<string | null>("Hoje");

  const today = parseISO(hojeISO());
  const [viewYear,  setViewYear]  = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());

  function prevMonth() {
    if (viewMonth === 0) { setViewYear(y => y-1); setViewMonth(11); }
    else setViewMonth(m => m-1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear(y => y+1); setViewMonth(0); }
    else setViewMonth(m => m+1);
  }

  function handleDayClick(iso: string) {
    setActivePreset(null); // seleção manual — sem preset
    if (selecting === "start") {
      setTempFrom(iso);
      setTempTo(iso);
      setSelecting("end");
    } else {
      // Se clicar numa data antes do start, inverte
      if (iso < tempFrom) {
        setTempFrom(iso);
        setTempTo(tempFrom);
      } else {
        setTempTo(iso);
      }
      setSelecting("start");
      onChange(iso < tempFrom ? iso : tempFrom, iso < tempFrom ? tempFrom : iso);
      setOpen(false);
    }
  }

  function applyPreset(label: string, getRange: () => string[]) {
    const [f, t] = getRange();
    setTempFrom(f);
    setTempTo(t);
    setSelecting("start");
    setActivePreset(label);
    onChange(f, t);
    setOpen(false);
  }

  // Dias do mês atual para renderizar
  const firstDay = new Date(viewYear, viewMonth, 1).getDay(); // 0=dom
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();

  // Range efetivo para highlight (inclui hover durante seleção de end)
  const rangeStart = tempFrom;
  const rangeEnd   = selecting === "end" && hover
    ? (hover < tempFrom ? tempFrom : hover)
    : tempTo;
  const rangeMin   = selecting === "end" && hover && hover < tempFrom ? hover : rangeStart;

  function dayStyle(iso: string): React.CSSProperties {
    const isStart   = iso === tempFrom;
    const isEnd     = iso === (selecting === "end" && hover ? (hover < tempFrom ? tempFrom : hover) : tempTo);
    const inRange   = iso > rangeMin && iso < rangeEnd;
    const isToday   = iso === hojeISO();
    const isHover   = hover === iso;
    const future    = iso > toISO(today);

    return {
      width: "34px", height: "34px",
      display: "flex", alignItems: "center", justifyContent: "center",
      borderRadius: isStart || isEnd ? "50%" : "0",
      background: isStart || isEnd
        ? "linear-gradient(135deg,#ff6b00,#ffb800)"
        : inRange
          ? "rgba(255,107,0,0.12)"
          : isHover && !future
            ? "rgba(255,255,255,0.07)"
            : "transparent",
      color: isStart || isEnd ? "#10131b" : future ? "#444" : isToday ? "#ff6b00" : "#d7dbe5",
      fontWeight: isStart || isEnd ? 900 : isToday ? 800 : 500,
      fontSize: "13px",
      cursor: future ? "default" : "pointer",
      outline: isToday && !isStart && !isEnd ? "1px solid rgba(255,107,0,0.4)" : "none",
      outlineOffset: "-1px",
      borderRadius2: "0",
      transition: "background 0.1s",
    } as React.CSSProperties;
  }

  // Label do intervalo selecionado
  function fmtLabel(iso: string) {
    const d = parseISO(iso);
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" }).replace(".", "");
  }

  const label = activePreset ?? (from === to
    ? fmtLabel(from)
    : `${fmtLabel(from)} → ${fmtLabel(to)}`);

  return (
    <div style={{ position: "relative" }}>
      {/* Trigger */}
      <button
        onClick={() => {
          setTempFrom(from);
          setTempTo(to);
          setSelecting("start");
          setOpen(v => !v);
        }}
        style={{
          padding: "9px 14px",
          borderRadius: "10px",
          border: `1px solid ${open ? "rgba(255,107,0,0.4)" : "rgba(255,255,255,0.1)"}`,
          background: open ? "rgba(255,107,0,0.08)" : "rgba(255,255,255,0.05)",
          color: open ? "#ff6b00" : "#d7dbe5",
          fontWeight: 700,
          fontSize: "13px",
          cursor: "pointer",
          display: "flex", alignItems: "center", gap: "8px",
          whiteSpace: "nowrap",
        }}
      >
        <span style={{ fontSize: "14px" }}>📅</span>
        {label}
        <span style={{ fontSize: "10px", opacity: 0.5 }}>▾</span>
      </button>

      {/* Dropdown */}
      {open && (
        <>
          {/* overlay para fechar */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: "fixed", inset: 0, zIndex: 9998 }}
          />
          <div style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            zIndex: 9999,
            background: "#111318",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "18px",
            padding: "16px",
            display: "flex",
            gap: "16px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
          }}>

            {/* Presets */}
            <div style={{ display: "flex", flexDirection: "column", gap: "4px", minWidth: "120px", paddingRight: "16px", borderRight: "1px solid rgba(255,255,255,0.07)" }}>
              <div style={{ fontSize: "10px", fontWeight: 700, color: "#9099aa", letterSpacing: "0.4px", marginBottom: "6px" }}>ATALHOS</div>
              {PRESETS.map(p => {
                const active = activePreset === p.label;
                return (
                  <button
                    key={p.label}
                    onClick={() => applyPreset(p.label, p.get)}
                    style={{
                      padding: "7px 12px",
                      borderRadius: "8px",
                      border: "none",
                      background: active ? "rgba(255,107,0,0.15)" : "transparent",
                      color: active ? "#ff6b00" : "#9099aa",
                      fontWeight: active ? 800 : 600,
                      fontSize: "13px",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>

            {/* Calendário */}
            <div>
              {/* Hint */}
              <div style={{ fontSize: "11px", color: "#9099aa", marginBottom: "10px", textAlign: "center" }}>
                {selecting === "start" ? "Clique no dia inicial" : "Clique no dia final"}
              </div>

              {/* Nav do mês */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "10px" }}>
                <button onClick={prevMonth} style={{ background: "none", border: "none", color: "#9099aa", cursor: "pointer", fontSize: "18px", padding: "0 6px" }}>‹</button>
                <span style={{ fontWeight: 800, fontSize: "14px" }}>{MESES[viewMonth]} {viewYear}</span>
                <button onClick={nextMonth} style={{ background: "none", border: "none", color: "#9099aa", cursor: "pointer", fontSize: "18px", padding: "0 6px" }}>›</button>
              </div>

              {/* Cabeçalho dias */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 34px)", gap: "2px", marginBottom: "4px" }}>
                {DIAS.map(d => (
                  <div key={d} style={{ textAlign: "center", fontSize: "10px", fontWeight: 700, color: "#9099aa", height: "24px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                    {d}
                  </div>
                ))}
              </div>

              {/* Dias */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 34px)", gap: "2px" }}>
                {/* Células vazias */}
                {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}

                {Array.from({ length: daysInMonth }).map((_, i) => {
                  const day = i + 1;
                  const iso = `${viewYear}-${String(viewMonth + 1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
                  const future = iso > toISO(today);
                  return (
                    <div
                      key={iso}
                      style={dayStyle(iso)}
                      onClick={() => !future && handleDayClick(iso)}
                      onMouseEnter={() => !future && setHover(iso)}
                      onMouseLeave={() => setHover(null)}
                    >
                      {day}
                    </div>
                  );
                })}
              </div>

              {/* Range selecionado */}
              {tempFrom && tempTo && (
                <div style={{ marginTop: "12px", textAlign: "center", fontSize: "12px", color: "#ff6b00", fontWeight: 700 }}>
                  {tempFrom === tempTo
                    ? parseISO(tempFrom).toLocaleDateString("pt-BR")
                    : `${parseISO(tempFrom).toLocaleDateString("pt-BR")} → ${parseISO(tempTo).toLocaleDateString("pt-BR")}`
                  }
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
