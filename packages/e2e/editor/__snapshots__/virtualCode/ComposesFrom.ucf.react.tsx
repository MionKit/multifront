
  export default function Tag({ label }: { label: string }) {
    return <span className={`${$style.tag} ${$style.chip} ${$style.pill}`}>{label}</span>
  }
