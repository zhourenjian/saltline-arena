import { Vector3 } from "../vendor/three-r180.js";

function createCombat(context) {
  let e = {
    shots: 0,
    hits: 0,
    kills: 0,
  };
  return (
    context.events.on("enemy:killed", () => {
      e.kills++;
    }),
    {
      stats: e,
      reset() {
        e.shots = e.hits = e.kills = 0;
      },
      playerShot(
        n,
        s,
        { damage: o = 28, range: r = 300, impulse: a = 1 } = {},
      ) {
        e.shots++;
        let l = context.physics.raycast(n, s, r),
          c = context.enemies.raycast(n, s, l ? l.dist : r),
          tg = context.shotTargets,
          th = null;
        // other shootable bodies (the 1v1 opponent): nearest hit in front of walls and enemies wins
        if (tg && tg.length) {
          let lim = c ? c.dist : l ? l.dist : r;
          for (let i = 0; i < tg.length; i++) {
            let hit = tg[i].raycast(n, s, lim);
            hit && hit.dist < lim && ((lim = hit.dist), (th = hit), (th.target = tg[i]));
          }
        }
        if (th) {
          e.hits++;
          let f = {
            point: th.point,
            normal: th.normal || s.clone().negate(),
            dist: th.dist,
            surface: "enemy",
            enemy: th.target.ref || th.target,
            part: th.part,
            dir: s,
            from: "player",
            killed: !1,
            remote: !0,
          };
          return (
            th.target.onHit(th),
            context.events.emit("impact", f),
            context.events.emit("player:hitEnemy", {
              enemy: f.enemy,
              part: th.part,
              killed: !1,
              weak: th.part === "head",
              remote: !0,
            }),
            f
          );
        }
        if (c) {
          e.hits++;
          let u = c.part === "weak" ? 2.2 : 1,
            h = c.enemy.damage(o * u, c.point, s, c.part) === !0,
            f = {
              point: c.point,
              normal: c.normal || s.clone().negate(),
              dist: c.dist,
              surface: "enemy",
              enemy: c.enemy,
              part: c.part,
              dir: s,
              from: "player",
              killed: h,
            };
          return (
            context.events.emit("impact", f),
            context.events.emit("player:hitEnemy", {
              enemy: c.enemy,
              part: c.part,
              killed: h,
              weak: c.part === "weak",
            }),
            f
          );
        }
        if (l) {
          let u = {
            point: l.point,
            normal: l.normal,
            dist: l.dist,
            surface: l.surface,
            enemy: null,
            dir: s,
            from: "player",
          };
          return (context.events.emit("impact", u), u);
        }
        return null;
      },
      enemyShot(n, s, { damage: o = 6, range: r = 200 } = {}) {
        let a = context.physics.raycast(n, s, r),
          l = a ? a.dist : r,
          c = context.player;
        if (c && c.alive) {
          let u = nm.copy(c.pos);
          u.y += 1;
          let h = u.sub(n).dot(s);
          if (h > 0 && h < l) {
            zf.copy(n).addScaledVector(s, h);
            let f = Math.abs(zf.y - (c.pos.y + 0.95));
            if (Math.hypot(zf.x - c.pos.x, zf.z - c.pos.z) < 0.38 && f < 0.95)
              return (c.damage(o, n), !0);
          }
        }
        return (
          a &&
            context.events.emit("impact", {
              point: a.point,
              normal: a.normal,
              dist: a.dist,
              surface: a.surface,
              enemy: null,
              dir: s,
              from: "enemy",
            }),
          !1
        );
      },
      explode(n, s = 5, o = 80, r = "player") {
        for (let l of context.enemies.list) {
          if (!l.alive) continue;
          let c = l.pos.distanceTo(n);
          c < s &&
            context.physics.lineOfSight(
              n,
              nm.copy(l.pos).setY(l.pos.y + 0.5),
            ) &&
            l.damage(
              o * (1 - c / s),
              l.pos,
              zf.copy(l.pos).sub(n).normalize(),
              "body",
            );
        }
        let a = context.player;
        if (a && a.alive) {
          let l = nm
            .copy(a.pos)
            .setY(a.pos.y + 1)
            .distanceTo(n);
          l < s &&
            context.physics.lineOfSight(n, nm.copy(a.pos).setY(a.pos.y + 1)) &&
            a.damage(o * 0.5 * (1 - l / s), n);
        }
      },
    }
  );
}

var nm = new Vector3();

var zf = new Vector3();

export { createCombat };
