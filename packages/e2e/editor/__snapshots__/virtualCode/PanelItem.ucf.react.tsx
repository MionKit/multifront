
  export default function PanelItem({ label }: { label: string } & {className?: string; style?: import('react').CSSProperties; ref?: import('react').Ref<import('react').ComponentRef<'p'>>}) {
    return <p className="item" data-marker="panel-item-react-marker">{label}</p>
  }
