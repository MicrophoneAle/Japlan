This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Itinerary research lab

`/itinerary` is a development-only, no-database draft-itinerary workflow. It
uses the development fixture in `lib/itinerary/config.ts`; its dates are inclusive
calendar dates and every preference can be edited in that one file. Results and the Research
Inspector remain available for the current browser session only.

Set these values in `.env.local` before running a real generation:

```env
ITINERARY_RESEARCH_MODE=real
BROWSERBASE_API_KEY=
BROWSERBASE_PROJECT_ID=
GEMINI_API_KEY=
GEMINI_FAST_MODEL=
GEMINI_SMART_MODEL=
STAGEHAND_MODEL=google/gemini-3.6-flash
ITINERARY_RESEARCH_STRATEGY=fast
```

Open `/itinerary` and choose **Generate Itinerary**. Real mode uses a
parallel Foursquare discovery plus bounded Browserbase Search/Fetch enrichment
for source-backed candidates, then Gemini selects only those candidates for an
unvalidated draft. Set `ITINERARY_RESEARCH_STRATEGY=deep` only when you want
the slower Stagehand browser workflow. The developer
Research Inspector shows URLs, actions, candidates, selections, and Browserbase
session metadata for that generation.

For deterministic UI development only, set `ITINERARY_RESEARCH_MODE=mock`.
This explicitly switches both research and draft assembly to deterministic test
data; it is never selected automatically and throws when `NODE_ENV=production`.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
