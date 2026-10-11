import Card from '../../../components/Card.ucf';
import Counter from '../../../components/Counter.ucf';
import ScopedPanel from '../../../components/react/ScopedPanel.ucf';
import HelperCard from './card.ts';

export default function App() {
  return (
    <>
      <section data-demo="counter">
        <Counter />
      </section>
      <section data-demo="panel">
        <ScopedPanel />
      </section>
      <section data-demo="card">
        <Card title="Bare import" />
        <HelperCard title="From the .ts helper" />
      </section>
    </>
  );
}
