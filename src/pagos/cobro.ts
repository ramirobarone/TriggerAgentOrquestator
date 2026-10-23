export interface Cobro {
  id: string;
  importe: number;
}

export function registrarCobro(cobro: Cobro): Cobro {
  if (cobro.importe <= 0) {
    throw new Error("El importe debe ser positivo");
  }
  return cobro;
}
