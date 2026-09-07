---
name: i18n-parity
description: Audit and fix translation files across locales, with a focus on English and French parity. Use when adding or reviewing translations, when locale files drift out of sync, when a placeholder or plural renders wrong, or whenever the user asks about i18n, l10n, localization, translation keys, or pluralization.
---

# Translation parity

Translation bugs are quiet. A missing key renders as `nav.settings` in the interface, a translated placeholder renders as a literal `:nom`, and neither throws an error in CI. They get found by users.

This skill checks locale files mechanically, then covers the language-specific rules that a key-by-key diff cannot catch.

## Run the checker first

```bash
node scripts/check-parity.mjs
```

It auto-detects the layout. Supported without configuration:

| Layout | Used by |
| :--- | :--- |
| `lang/{locale}/*.php` | Laravel, needs `php` on PATH |
| `lang/{locale}.json` | Laravel JSON translations |
| `messages/{locale}.json` | next-intl |
| `locales/{locale}/*.json` | react-i18next, vue-i18n |

Options: `--source en` to change the reference locale, `--dir path` to point at an unusual layout, `--json` for machine-readable output.

It exits 1 on anything a user would see: missing keys, empty values, placeholder mismatches. Untranslated values and extra keys warn but do not block, because sometimes a string genuinely is identical in both languages.

Wire it into CI. Drift is easier to prevent than to repair.

## What the checker finds

- **Missing keys.** Present in the source locale, absent in the target.
- **Empty values.** A key that exists with an empty string, which is worse than missing because fallback logic often skips it.
- **Placeholder mismatch.** The most damaging class. See below.
- **Plural branch mismatch.** Source has two branches, target has one.
- **Possibly untranslated.** Identical multi-word values.
- **Extra keys.** In the target and not the source, usually left over from a removed feature.

## Placeholders must not be translated

This is the single most common French localization bug, because the placeholder name looks like a word.

```php
// en
'welcome' => 'Hello :name, you have :count messages',

// Wrong: the placeholder was translated along with the sentence.
'welcome' => 'Bonjour :nom, vous avez :count messages',
```

`:nom` never gets substituted. The user sees the literal text `:nom`. The checker catches this by comparing the placeholder sets on both sides.

Same rule for ICU and next-intl: `{name}` stays `{name}`, only the surrounding text changes.

## Pluralization

**English and French do not agree on zero.** English treats 0 as plural, French treats it as singular.

| Count | English | French |
| ---: | :--- | :--- |
| 0 | 0 item**s** | 0 article |
| 1 | 1 item | 1 article |
| 2 | 2 item**s** | 2 article**s** |

Laravel's `MessageSelector` already implements the French rule, so `trans_choice` picks the right branch as long as you use it. The bug appears when someone builds the string by hand:

```php
// Wrong: applies the English rule to French.
$label = $count === 1 ? 'article' : 'articles';

// Right.
trans_choice('messages.articles', $count);
```

```php
// lang/fr/messages.php
'articles' => 'article|articles',
```

For explicit ranges, Laravel accepts:

```php
'inbox' => '{0} Aucun message|{1} Un message|[2,*] :count messages',
```

In ICU, which next-intl and formatjs use, French needs its own categories. Do not assume `one` and `other` map across languages the same way:

```
{count, plural, =0 {Aucun article} one {# article} other {# articles}}
```

Languages with more than two forms (Arabic has six, Russian and Polish have three) will silently fall back to `other` if the categories are missing. If the project targets any of those, check the CLDR categories rather than copying the English structure.

## French typography

Reviewers miss these and native speakers notice immediately.

- **Narrow non-breaking space before `; : ! ?` and inside `« »`.** `Bonjour !` not `Bonjour!`. The character is U+202F, or U+00A0 as the widely supported fallback. A regular space lets the punctuation wrap to the next line on its own.
- **Guillemets for quotations**, `« comme ceci »`, not `"like this"`.
- **Decimal comma and space thousands separator.** `1 234,56` not `1,234.56`. Use `Intl.NumberFormat('fr-FR')` or PHP's `NumberFormatter`, never string manipulation.
- **Lowercase months and weekdays.** `7 septembre 2026`, not `7 Septembre 2026`.
- **Currency after the amount.** `12,50 €` not `€12.50`.
- **Capitalization in titles is sentence case**, not title case. `Paramètres du compte`, not `Paramètres Du Compte`.

## Hardcoded strings

Keys that exist in both locales are only half the job. Strings never extracted at all are the other half.

```bash
# Laravel Blade
rg -n --glob '*.blade.php' '>[A-Z][a-z]+ [a-z ]{4,}<'

# React and Next.js JSX text nodes
rg -n --glob '*.tsx' '>\s*[A-Z][a-z]+ [a-z][a-z ]{4,}\s*<'

# User-facing strings in validation and exceptions
rg -n --type php "(abort|throw new \w+Exception)\(\s*\d*,?\s*['\"][A-Z]"
```

Expect false positives from component names and code identifiers. Skim, do not automate the fix.

Also check the places translations get forgotten by convention: validation messages, mail subjects and bodies, notification titles, PDF and export headers, `aria-label` and `alt` attributes, error pages, and enum labels rendered in the interface.

## Adding a locale

1. Copy the source locale files, keeping every key.
2. Translate values only. Never touch keys or placeholders.
3. Register the locale in the framework config. Laravel: `config/app.php` plus the `locale` middleware. next-intl: the routing config and middleware matcher.
4. Set the `lang` attribute on the html element. Screen readers and browser translation both depend on it.
5. Run the checker.
6. Check date, number and currency formatting actually switched, not just the strings.

## Reviewing a translation pull request

- Run the checker and paste the output.
- Confirm no key or placeholder changed. `git diff` should show changes on the right side of `=>` only.
- Spot-check the longest strings, where meaning drifts most.
- Check the French typography rules above.
- Confirm anything user-visible added in the same PR was extracted rather than hardcoded.
