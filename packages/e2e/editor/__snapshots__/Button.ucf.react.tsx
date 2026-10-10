
  export default function Button({ label }: { label: string }) {
    return <button className={`button ${classes.primary}`}>{label}</button>
  }
declare const classes: {readonly primary: string};
