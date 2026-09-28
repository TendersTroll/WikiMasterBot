/* API shapes verified against the site's saved friends and trade clients. */
(() => {
  'use strict';
  class TradeRunner {
    constructor({request, report, sleep, journal}) {
      Object.assign(this, {request, report, sleep, journal});
      this.stopped = false;
      this.sent = 0;
    }
    check() { if (this.stopped) throw new Error('Arrêt demandé. Les offres déjà envoyées restent sur le site.'); }
    async read(path) { this.check(); return this.request(path); }
    async friends() {
      const data = await this.read('/api/friends');
      if (!Array.isArray(data.friendships)) throw new Error('Liste des amis non reconnue.');
      return data.friendships;
    }
    relation(rows, target) {
      return rows.find(f => f.requester_id === target || f.addressee_id === target);
    }
    owner(f, target) { return f.requester_id === target ? f.addressee_id : f.requester_id; }
    async run(username, {testOne = false} = {}) {
      username = username.trim();
      this.report('Recherche du destinataire : ' + username + '…');
      const users = (await this.read('/api/friends/search?q=' + encodeURIComponent(username))).users;
      const matches = Array.isArray(users) ? users.filter(u => u.username?.toLowerCase() === username.toLowerCase()) : [];
      if (matches.length !== 1 || !matches[0].id) throw new Error('Pseudo exact introuvable ou ambigu.');
      const target = matches[0];
      let relation = this.relation(await this.friends(), target.id);
      if (!relation) {
        this.check();
        this.report('Envoi de la demande d’ami à ' + target.username + '…');
        await this.request('/api/friends', {addressee_id: target.id});
      }
      const deadline = Date.now() + 30 * 60 * 1000;
      let source = relation ? this.owner(relation, target.id) : null;
      if (source) { try { await chrome.runtime.sendMessage({type:'wmph_trade', action:'sourceReady', sourceId:source, targetUsername:target.username}); } catch {} }
      while (true) {
        relation = this.relation(await this.friends(), target.id);
        if (relation) {
          const current = this.owner(relation, target.id);
          if (!current || current === target.id || (source && source !== current)) throw new Error('Le compte source a changé.');
          source = current;
          try { await chrome.runtime.sendMessage({type:'wmph_trade', action:'sourceReady', sourceId:source, targetUsername:target.username, accepted:relation.status === 'accepted'}); } catch {}
          if (relation.status === 'accepted') break;
          if (relation.status !== 'pending') throw new Error('Demande d’ami refusée ou indisponible.');
        }
        if (Date.now() >= deadline) throw new Error('Attente expirée après 30 minutes. Relance après acceptation.');
        this.report('Accepte la demande sur ' + target.username + '. Vérification toutes les 5 secondes…');
        await this.sleep(5000);
      }
      const journalKey = 'wmph_trade_uncertain_' + source;
      const uncertain = await this.journal.get(journalKey);
      if (uncertain) throw new Error('Un précédent envoi est incertain' + (uncertain.target ? ' vers ' + uncertain.target : '') + '. Changer de pseudo ne débloque pas cet envoi. Vérifie les offres envoyées puis utilise « Envoi vérifié » dans cette fenêtre.');
      this.report('Ami accepté — lecture de toutes les pages de la collection…');
      const cards = new Map();
      let ended = false;
      for (let page = 0; page < 10000; page++) {
        const data = await this.read('/api/my-collection?sort=rarity&page=' + page + '&stats=0');
        if (!Array.isArray(data.collection)) throw new Error('Collection non reconnue.');
        if (data.collection.length === 0) { ended = true; break; }
        const previousSize = cards.size;
        for (const card of data.collection) {
          if (!card.id || !card.card?.id) throw new Error('Identifiant de carte manquant.');
          if (card.user_id && card.user_id !== source) throw new Error('Le propriétaire de la collection a changé.');
          cards.set(card.id, card);
        }
        if (cards.size === previousSize) throw new Error('Pagination de collection bloquée.');
      }
      if (!ended) throw new Error('Collection trop grande : lecture interrompue.');
      if (!cards.size) { this.report('Collection vide — aucune offre envoyée.'); return; }
      const active = await this.read('/api/trades?active=1');
      if (!Array.isArray(active.trades)) throw new Error('Liste des échanges non reconnue.');
      const pending = new Set();
      for (const trade of active.trades) if (trade.status === 'pending') {
        if (!Array.isArray(trade.items)) throw new Error('Détails des échanges en attente manquants.');
        for (const item of trade.items) if (item.offered_by === source) pending.add(item.card_id);
      }
      // Keep identical card types in one offer: the site locks pending card IDs.
      const groups = new Map();
      let skipped = 0;
      for (const card of cards.values()) {
        if (pending.has(card.card.id)) { skipped++; continue; }
        if (!groups.has(card.card.id)) groups.set(card.card.id, []);
        groups.get(card.card.id).push(card);
      }
      const batches = [];
      let batch = [];
      for (const group of groups.values()) {
        if (testOne) { batch = [group[0]]; break; }
        if (group.length > 100) throw new Error('Plus de 100 exemplaires d’une même carte : échange manuel nécessaire.');
        if (batch.length + group.length > 100) { batches.push(batch); batch = []; }
        batch.push(...group);
      }
      if (batch.length) batches.push(batch);
      if (!batches.length && skipped) {
        this.report('Aucune nouvelle offre envoyée à ' + target.username + ' : les ' + skipped + ' carte(s) sont déjà engagée(s) dans des offres en attente. Consulte Échanges → Envoyées. Pour les proposer à une autre personne, annule toi-même les anciennes offres sur le site, puis relance.');
        return;
      }
      for (const [index, items] of batches.entries()) {
        const current = this.relation(await this.friends(), target.id);
        if (!current || current.status !== 'accepted' || this.owner(current, target.id) !== source) throw new Error('Compte ou amitié modifié : arrêt.');
        this.check();
        await this.journal.set(journalKey, {target: target.username, count: items.length, at: Date.now()});
        this.check();
        this.report('Envoi de l’offre ' + (index + 1) + '/' + batches.length + ' (' + items.length + ' cartes)…');
        // Never retry a POST automatically: a lost response may hide a successful offer.
        await this.request('/api/trades', {
          recipient_id: target.id,
          items: items.map(c => ({user_card_id: c.id, card_id: c.card.id, offered_by: source})),
          initiator_wikibidous: 0, recipient_wikibidous: 0
        });
        this.sent += items.length;
        await this.journal.remove(journalKey);
      }
      this.report((testOne ? 'Test terminé — ' : '') + this.sent + ' carte(s) proposée(s) à ' + target.username + ', rien demandé en retour.' + (testOne ? ' Aucune autre offre envoyée.' : '') + (skipped ? ' ' + skipped + ' carte(s) déjà engagée(s), ignorée(s).' : ''));
    }
  }
  globalThis.WMPHTradeRunner = TradeRunner;
})();
