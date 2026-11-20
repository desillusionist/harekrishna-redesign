# Шри Чайтанья Сарасват Матх — новый дизайн (бета)

A mobile-first redesign preview of [harekrishna.ru](https://harekrishna.ru/), served by GitHub Pages.

- `index.html` is the whole site: static HTML, CSS and JS, no build step.
- `scripts/scrape.mjs` reads public pages of harekrishna.ru (video, audio, articles, news, home page) and saves them to `data/`. Articles, audio and video then open inside the new design.
- `.github/workflows/refresh.yml` runs the reader every 3 hours and commits new data. Run it by hand from the **Actions** tab ("Run workflow"; tick *debug* to print page structure).
- The reader is read-only and polite: one request at a time, 1.5 s apart, at most 40 new article pages per run.

All materials belong to Шри Чайтанья Сарасват Матх. When reusing them, an active link to harekrishna.ru is required.

If harekrishna.ru changes its page layout, a run may find nothing; the site then keeps showing the last good data.
