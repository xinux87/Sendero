"""Salvaguarda del watcher: no debe vigilar la carpeta de datos de Sendero."""
import watch


def test_bandeja_vacia_no_es_datos(tmp_path):
    assert watch.looks_like_data_dir(tmp_path) is False


def test_detecta_por_la_bd(tmp_path):
    (tmp_path / "sendero.db").write_text("")
    assert watch.looks_like_data_dir(tmp_path) is True


def test_detecta_por_gpx_y_thumbs(tmp_path):
    (tmp_path / "gpx").mkdir()
    (tmp_path / "thumbs").mkdir()
    assert watch.looks_like_data_dir(tmp_path) is True


def test_solo_gpx_no_basta(tmp_path):
    # Un buzón con una carpeta 'gpx' suelta no debe confundirse con la de datos.
    (tmp_path / "gpx").mkdir()
    assert watch.looks_like_data_dir(tmp_path) is False
