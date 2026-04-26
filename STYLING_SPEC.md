# NEXUS.OS Styling Specification
## Industrial Minimalism Dashboard Framework

### 1. Typography
*   **Primary Font (UI & Headings)**: `Space Grotesk`
    *   *Weight*: 300 (Light), 500 (Medium), 700 (Bold)
    *   *Usage*: Page titles, card headers, high-level statistics.
*   **Secondary Font (Technical & Meta)**: `JetBrains Mono`
    *   *Weight*: 400 (Regular), 700 (Bold)
    *   *Usage*: Status labels, table data, timestamps, system logs, labels.

### 2. Color Palette
#### Light Mode
*   **Background**: `#FFFFFF`
*   **Surface (Cards)**: `#F8FAFC` (Slate 50)
*   **Accent (Primary)**: `#EA580C` (Orange 600)
*   **Accent (Secondary)**: `#059669` (Emerald 600)
*   **Borders**: `#E2E8F0` (Slate 200)
*   **Text (Primary)**: `#0F172A` (Slate 900)
*   **Text (Muted)**: `#64748B` (Slate 500)

#### Dark Mode
*   **Background**: `#050505` (Pure Deep Black)
*   **Surface (Cards)**: `rgba(255, 255, 255, 0.03)` with glassmorphism
*   **Accent (Primary)**: `#FB923C` (Orange 400)
*   **Accent (Secondary)**: `#10B981` (Emerald 400)
*   **Borders**: `rgba(255, 255, 255, 0.05)`
*   **Text (Primary)**: `rgba(255, 255, 255, 0.9)`
*   **Text (Muted)**: `rgba(255, 255, 255, 0.3)`

### 3. Layout & Geometry
*   **Border Radius**: `0px` (Strict industrial square corners).
*   **Decorative Elements**:
    *   **Corner Brackets**: 8x8px `border-top/right` and `border-bottom/left` indicators on cards.
    *   **Grid Overlay**: 24px square background grid at 3% opacity.
    *   **Scanline**: Animated horizontal gradient overlay for "active terminal" effect.
*   **Spacing**: 
    *   Gap: `1.5rem` (24px) for major components.
    *   Padding: `1rem` (16px) for compact cards, `1.5rem` (24px) for hero elements.

### 4. Component Specs
*   **Cards**: Minimal shadows, rely on 1px borders for definition.
*   **Charts**: Area charts with `stepAfter` interpolation; no Y-axis lines; 9px Mono ticks.
*   **Buttons**: Monospace text, uppercase, tracking `0.1em`, 1px solid borders.
