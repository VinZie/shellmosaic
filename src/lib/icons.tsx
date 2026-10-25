import type { LucideIcon, LucideProps } from "lucide-react";
import {
  Activity, Anchor, AppWindow, ArrowDownUp, ArrowLeft, ArrowRight, ArrowUp, Atom, Bell, BellRing, Binary, BookOpen,
  Bot, Box, Boxes, Braces, Brain, Briefcase, Bug, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Circle,
  CircleDot, ClipboardCopy, ClipboardPaste, Cloud, Code, Coffee, Columns2, Command, Compass, Container, Copy, Cpu,
  Crosshair, Crown, Database, Download, Ellipsis, Eraser, ExternalLink, Eye, EyeOff, File, FileCode, FilePlus,
  FileText, FingerprintPattern, Flag, FlaskConical, Flame, Folder, FolderGit2, FolderOpen, FolderPlus, FolderTree,
  Funnel, Gamepad2, Gauge, Gem, Ghost, GitBranch, GitCommitHorizontal, Globe, GripVertical, Hammer, HardDrive, Hash,
  Headphones, Heart, House, Image, ImageOff, Info, Joystick, Key, Keyboard, Layers, LayoutGrid, Leaf, ListChecks,
  ListTree, LoaderCircle, Lock, Maximize2, MemoryStick, Minimize2, Minus, Monitor, Moon, Mountain, Network,
  NotebookPen, Package, Palette, PanelRight, Pause, PawPrint, Pencil, Pin, PinOff, Plane, Play, Plug, Plus, Power,
  Puzzle, Radar, Radio, RefreshCw, Rocket, RotateCw, Router, Rows2, Satellite, Save, ScrollText, Search, Server,
  Settings, Shield, Skull, SlidersHorizontal, Sparkles, Square, SquareTerminal, Star, Sun, Swords, Target, Terminal,
  TextWrap, Timer, Trash, TriangleAlert, Trophy, Tv, Upload, WandSparkles, Webhook, Wifi, Workflow, Wrench, X, Zap,
  ChartLine, Expand, Shrink, Undo2, Import, Share2, Type, Regex, CaseSensitive, WholeWord, ZoomIn, ZoomOut, Unplug,
  ArrowDownToLine, CornerDownLeft, Tag, LockOpen, FolderSync, KeyRound, Clock, FileUp, FolderUp,
} from "lucide-react";

/** Every icon the app can reference by name (workspace icons, module icons, menus). */
export const ICONS: Record<string, LucideIcon> = {
  activity: Activity, anchor: Anchor, "app-window": AppWindow, "arrow-down-up": ArrowDownUp, "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight, "arrow-up": ArrowUp, atom: Atom, bell: Bell, "bell-ring": BellRing, binary: Binary,
  "book-open": BookOpen, bot: Bot, box: Box, boxes: Boxes, braces: Braces, brain: Brain, briefcase: Briefcase, bug: Bug,
  check: Check, "chevron-down": ChevronDown, "chevron-left": ChevronLeft, "chevron-right": ChevronRight,
  "chevron-up": ChevronUp, circle: Circle, "circle-dot": CircleDot, "clipboard-copy": ClipboardCopy,
  "clipboard-paste": ClipboardPaste, cloud: Cloud, code: Code, coffee: Coffee, "columns-2": Columns2, command: Command,
  compass: Compass, container: Container, copy: Copy, cpu: Cpu, crosshair: Crosshair, crown: Crown, database: Database,
  download: Download, ellipsis: Ellipsis, eraser: Eraser, "external-link": ExternalLink, eye: Eye, "eye-off": EyeOff,
  file: File, "file-code": FileCode, "file-plus": FilePlus, "file-text": FileText, fingerprint: FingerprintPattern,
  flag: Flag, flask: FlaskConical, flame: Flame, folder: Folder, "folder-git": FolderGit2, "folder-open": FolderOpen,
  "folder-plus": FolderPlus, "folder-tree": FolderTree, filter: Funnel, "gamepad-2": Gamepad2, gauge: Gauge, gem: Gem,
  ghost: Ghost, "git-branch": GitBranch, "git-commit": GitCommitHorizontal, globe: Globe, grip: GripVertical,
  hammer: Hammer, "hard-drive": HardDrive, hash: Hash, headphones: Headphones, heart: Heart, home: House, image: Image,
  "image-off": ImageOff, info: Info, joystick: Joystick, key: Key, keyboard: Keyboard, layers: Layers,
  "layout-grid": LayoutGrid, leaf: Leaf, "list-checks": ListChecks, "list-tree": ListTree, loader: LoaderCircle,
  lock: Lock, maximize: Maximize2, memory: MemoryStick, minimize: Minimize2, minus: Minus, monitor: Monitor,
  moon: Moon, mountain: Mountain, network: Network, notebook: NotebookPen, package: Package, palette: Palette,
  "panel-right": PanelRight, pause: Pause, "paw-print": PawPrint, pencil: Pencil, pin: Pin, "pin-off": PinOff,
  plane: Plane, play: Play, plug: Plug, plus: Plus, power: Power, puzzle: Puzzle, radar: Radar, radio: Radio,
  refresh: RefreshCw, rocket: Rocket, "rotate-cw": RotateCw, router: Router, "rows-2": Rows2, satellite: Satellite,
  save: Save, scroll: ScrollText, search: Search, server: Server, settings: Settings, shield: Shield, skull: Skull,
  sliders: SlidersHorizontal, sparkles: Sparkles, square: Square, "square-terminal": SquareTerminal, star: Star,
  sun: Sun, swords: Swords, target: Target, terminal: Terminal, wrap: TextWrap, timer: Timer, trash: Trash,
  warning: TriangleAlert, trophy: Trophy, tv: Tv, upload: Upload, wand: WandSparkles, webhook: Webhook, wifi: Wifi,
  workflow: Workflow, wrench: Wrench, x: X, zap: Zap, "chart-line": ChartLine, expand: Expand, shrink: Shrink,
  undo: Undo2, import: Import, share: Share2, type: Type, regex: Regex, "case-sensitive": CaseSensitive,
  "whole-word": WholeWord, "zoom-in": ZoomIn, "zoom-out": ZoomOut, unplug: Unplug, "scroll-bottom": ArrowDownToLine,
  enter: CornerDownLeft, tag: Tag, "lock-open": LockOpen, "folder-sync": FolderSync, "key-round": KeyRound,
  clock: Clock, "file-up": FileUp, "folder-up": FolderUp,
};

/** Icons offered in the workspace/tab icon picker. */
export const PICKER_ICONS = [
  "square-terminal", "code", "braces", "rocket", "shield", "bug", "flame", "zap", "star", "heart", "coffee",
  "gamepad-2", "joystick", "skull", "crosshair", "target", "swords", "ghost", "fingerprint", "binary", "radar",
  "satellite", "box", "package", "hammer", "wrench", "database", "server", "cloud", "globe", "network", "router",
  "webhook", "brain", "bot", "atom", "flask", "key", "lock", "layers", "sparkles", "wand", "moon", "sun", "monitor",
  "tv", "headphones", "briefcase", "book-open", "notebook", "compass", "flag", "crown", "gem", "trophy", "leaf",
  "mountain", "anchor", "paw-print", "folder", "git-branch", "workflow", "gauge", "cpu", "hash",
];

export interface IconProps extends Omit<LucideProps, "ref"> {
  name: string;
}

/** Render an icon by name. Names that aren't icons (e.g. an emoji) render as text. */
export function Icon({ name, size = 16, ...rest }: IconProps) {
  // (own keys only: a name like "constructor" from a hand-edited file must not be rendered as a component)
  const Cmp = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : undefined;
  if (Cmp) return <Cmp size={size} strokeWidth={1.75} {...rest} />;
  return (
    <span className="icon-text" style={{ fontSize: Number(size) * 0.95, lineHeight: 1, width: size, textAlign: "center" }}>
      {name}
    </span>
  );
}
