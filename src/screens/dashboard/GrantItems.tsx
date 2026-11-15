import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/Button";
import { Banner } from "../../components/Banner";
import type { AdminAccount } from "../../api/admin";
import { PlayerTools } from "./PlayerTools";
import { grantToPlayer, searchCatalog, searchPlayers, type CatalogItem, type CatalogTab } from "../../api/adminGrants";

const TABS: { id: CatalogTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "weapons", label: "Weapons" },
  { id: "armour", label: "Armour" },
  { id: "lanterns", label: "Lanterns" },
  { id: "parts", label: "Weapon parts" },
  { id: "cells", label: "Cells" },
  { id: "cosmetics", label: "Cosmetics" },
  { id: "materials", label: "Materials" },
  { id: "currency", label: "Currency" },
  { id: "other", label: "Other" },
];

interface CartLine {
  id: string;
  name: string;
  quantity: number;
}

function errorText(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Something went wrong.";
}

const INPUT = "w-full glass rounded-2xl-raised px-3 py-2 text-sm text-text";

export function GrantItems() {
  const [query, setQuery] = useState("");
  const [players, setPlayers] = useState<AdminAccount[]>([]);
  const [player, setPlayer] = useState<AdminAccount | null>(null);
  const [tab, setTab] = useState<CatalogTab>("all");
  const [itemQuery, setItemQuery] = useState("");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [qty, setQty] = useState("1");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (player || query.trim().length < 2) {
      setPlayers([]);
      return;
    }
    const timer = setTimeout(() => {
      searchPlayers(query.trim()).then(setPlayers).catch((err) => setError(errorText(err)));
    }, 250);
    return () => clearTimeout(timer);
  }, [query, player]);

  useEffect(() => {
    if (!player) return;
    const timer = setTimeout(() => {
      searchCatalog(tab, itemQuery.trim()).then((result) => setItems(result.items)).catch((err) => setError(errorText(err)));
    }, 200);
    return () => clearTimeout(timer);
  }, [player, tab, itemQuery]);

  // Names are shown on their own; the id is only added where two items in the list share a name.
  const duplicateNames = useMemo(() => {
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const item of items) (seen.has(item.name) ? dupes : seen).add(item.name);
    return dupes;
  }, [items]);

  function addToCart(item: CatalogItem) {
    const quantity = Math.trunc(Number(qty)) || 1;
    setCart((current) => {
      const have = current.find((line) => line.id === item.id);
      if (have) return current.map((line) => (line === have ? { ...line, quantity: line.quantity + quantity } : line));
      return [...current, { id: item.id, name: item.name, quantity }];
    });
  }

  async function grant() {
    if (!player || cart.length === 0) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await grantToPlayer(player.userId, cart.filter((line) => line.quantity !== 0).map((line) => ({ catalogId: line.id, quantity: line.quantity })));
      setNotice(
        `Applied ${result.granted} change${result.granted === 1 ? "" : "s"} to ${player.displayName}. ` +
          (result.liveRefreshRequested ? "Connected players see it within seconds." : "They see it next time they log in."),
      );
      setCart([]);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="glass rounded-2xl p-6">
      <h2 className="text-[15px] font-semibold text-text">Grant items</h2>
      <p className="mt-0.5 text-xs text-text-muted">Find a player by name, Discord name or Discord ID, pick a category, and click items to add them. A negative quantity removes items. Additions show up for a connected player within seconds; removals only take effect after that player restarts the game.</p>
      {error && <div className="mt-3"><Banner>{error}</Banner></div>}
      {notice && <div className="mt-3"><Banner tone="muted">{notice}</Banner></div>}

      <div className="mt-4">
        {player ? (
          <div className="flex items-center justify-between glass rounded-2xl-raised px-3 py-2 text-sm text-text">
            <span>
              {player.displayName} <span className="text-text-muted">({player.discordUsername || player.userId})</span>
            </span>
            <button className="text-xs text-text-muted hover:text-text" onClick={() => { setPlayer(null); setCart([]); setNotice(null); }}>
              Change
            </button>
          </div>
        ) : (
          <>
            <input className={INPUT} placeholder="Search player (name, Discord name or ID)" value={query} onChange={(event) => setQuery(event.target.value)} />
            {players.length > 0 && (
              <ul className="mt-1 divide-y divide-border rounded-md border border-border">
                {players.map((account) => (
                  <li key={account.userId}>
                    <button className="w-full px-3 py-2 text-left text-sm text-text hover:bg-surface-raised" onClick={() => { setPlayer(account); setPlayers([]); }}>
                      {account.displayName} <span className="text-text-muted">{account.discordUsername} {account.discordId}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {player && (
        <div className="mt-4">
          <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-surface-raised p-1" role="tablist">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${tab === id ? "bg-accent-muted text-text" : "text-text-muted hover:text-text"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="mt-3 grid gap-4 md:grid-cols-2">
            <div>
              <div className="flex gap-2">
                <input className={INPUT} placeholder="Search by name" value={itemQuery} onChange={(event) => setItemQuery(event.target.value)} />
                <input className={`${INPUT} w-24`} type="number" value={qty} onChange={(event) => setQty(event.target.value)} aria-label="Quantity (negative removes)" title="Quantity. Use a negative number to remove." />
              </div>
              <ul className="mt-1 max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
                {items.length === 0 && <li className="px-3 py-2 text-xs text-text-muted">Nothing found.</li>}
                {items.map((item) => (
                  <li key={item.id}>
                    <button className="w-full px-3 py-1.5 text-left text-xs text-text hover:bg-surface-raised" onClick={() => addToCart(item)}>
                      {item.name}
                      {duplicateNames.has(item.name) && <span className="ml-2 text-text-muted">{item.id}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border">
                {cart.length === 0 && <li className="px-3 py-2 text-xs text-text-muted">Click items on the left to add them.</li>}
                {cart.map((line) => (
                  <li key={line.id} className="flex items-center justify-between px-3 py-1.5 text-xs text-text">
                    <span>{line.name} x{line.quantity}</span>
                    <button className="text-text-muted hover:text-text" onClick={() => setCart((current) => current.filter((entry) => entry !== line))}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-3">
                <Button onClick={grant} disabled={busy || cart.length === 0}>
                  {busy ? "Granting..." : `Grant to ${player.displayName}`}
                </Button>
              </div>
            </div>
          </div>
          <PlayerTools player={player} />
        </div>
      )}
    </section>
  );
}
