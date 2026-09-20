# Navbar icon and repository link

## Scope

Replace the landing page's circular text `j` mark with the existing transparent image at `public/assets/image-removebg-preview (7).png`. Preserve the current navbar dimensions, alignment, brand text, and top-of-page link.

Update the landing page's GitHub call-to-action to open the primary Japlan repository: `https://github.com/MicrophoneAle/Japlan`.

## Implementation

The root landing route, `app/page.tsx`, will reference the image from `/assets/image-removebg-preview (7).png` and use the primary repository URL on the existing GitHub button. The image will be styled through the existing global landing CSS to fit the former icon area without changing navbar layout.

## Verification

Run TypeScript type-checking and confirm the route references the requested asset and repository URL. No behavior outside the navbar mark or GitHub destination changes.
